import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import {
    createSecureContext,
    createServer as createTlsServer,
    TLSSocket
} from 'node:tls'
import { createTransport } from 'nodemailer'
import { smtpTransportOptions } from '../src/modules/email/email.service'

type Mode = 'absent' | 'rejected' | 'broken-tls' | 'starttls' | 'implicit'

const createCertificate = (t: TestContext) => {
    const dir = mkdtempSync(join(tmpdir(), 'manyfold-smtp-tls-'))
    t.after(() => rmSync(dir, { recursive: true }))
    const key = join(dir, 'key.pem')
    const cert = join(dir, 'cert.pem')
    // Generate short-lived fixture material instead of committing a private key.
    execFileSync(
        'openssl',
        [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-days',
            '1',
            '-subj',
            '/CN=localhost',
            '-keyout',
            key,
            '-out',
            cert
        ],
        { stdio: 'ignore', timeout: 10_000 }
    )
    return { key: readFileSync(key), cert: readFileSync(cert) }
}

const createRelay = async (t: TestContext, mode: Mode) => {
    const tls =
        mode === 'starttls' || mode === 'implicit' ? createCertificate(t) : null
    const sockets = new Set<Socket>()
    const commands: string[] = []
    const messages: string[] = []
    const auth: { encrypted: boolean; value: string }[] = []

    const track = (socket: Socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
        socket.on('error', () => {})
    }
    const converse = (
        socket: Socket,
        encrypted: boolean,
        greeting: boolean
    ) => {
        track(socket)
        let buffer = ''
        let message: string[] | null = null
        if (greeting) socket.write('220 localhost fixture ESMTP\r\n')
        const onData = (chunk: Buffer) => {
            buffer += chunk.toString()
            while (buffer.includes('\r\n')) {
                const end = buffer.indexOf('\r\n')
                const line = buffer.slice(0, end)
                buffer = buffer.slice(end + 2)
                if (message) {
                    if (line === '.') {
                        messages.push(message.join('\r\n'))
                        message = null
                        socket.write('250 queued\r\n')
                    } else message.push(line)
                    continue
                }
                const command = line.split(' ')[0].toUpperCase()
                commands.push(command)
                if (command === 'EHLO' || command === 'HELO') {
                    socket.write('250-localhost\r\n')
                    if (!encrypted && mode !== 'absent')
                        socket.write('250-STARTTLS\r\n')
                    socket.write('250 AUTH PLAIN\r\n')
                } else if (command === 'STARTTLS') {
                    if (mode === 'absent' || mode === 'rejected') {
                        socket.write('454 TLS unavailable\r\n')
                    } else {
                        socket.removeListener('data', onData)
                        socket.write('220 Ready to start TLS\r\n', () => {
                            if (mode === 'broken-tls') socket.destroy()
                            else {
                                assert.ok(tls)
                                const secure = new TLSSocket(socket, {
                                    isServer: true,
                                    secureContext: createSecureContext(tls)
                                })
                                converse(secure, true, false)
                            }
                        })
                        return
                    }
                } else if (command === 'AUTH') {
                    auth.push({
                        encrypted,
                        value: Buffer.from(
                            line.split(' ')[2],
                            'base64'
                        ).toString()
                    })
                    socket.write('235 authenticated\r\n')
                } else if (command === 'DATA') {
                    message = []
                    socket.write('354 End with a dot\r\n')
                } else if (command === 'QUIT') socket.end('221 bye\r\n')
                else socket.write('250 OK\r\n')
            }
        }
        socket.on('data', onData)
    }

    const server =
        mode === 'implicit'
            ? createTlsServer(tls!, (socket) => converse(socket, true, true))
            : createServer((socket) => converse(socket, false, true))
    server.on('connection', track)
    t.after(async () => {
        const closed = once(server, 'close')
        server.close()
        for (const socket of sockets) socket.destroy()
        await closed
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const transport = createTransport({
        ...smtpTransportOptions({
            provider: 'smtp',
            host: '127.0.0.1',
            port: address.port,
            secure: mode === 'implicit',
            username: 'fixture-user',
            password: '  fixture password\t ',
            from: 'sender@example.test',
            replyTo: null
        }),
        ...(tls ? { tls: { ca: tls.cert, servername: 'localhost' } } : {})
    })
    t.after(() => transport.close())
    return {
        commands,
        auth,
        messages,
        send: () =>
            transport.sendMail({
                from: 'sender@example.test',
                to: 'recipient@example.test',
                subject: 'SMTP transport fixture',
                text: 'SMTP fixture body'
            })
    }
}

for (const mode of ['absent', 'rejected', 'broken-tls'] as const) {
    test(
        `SMTP ${mode}: TLS failure sends no credentials or message`,
        {
            timeout: 10_000
        },
        async (t) => {
            const relay = await createRelay(t, mode)
            await assert.rejects(relay.send())
            assert.ok(relay.commands.includes('STARTTLS'))
            assert.deepEqual(relay.auth, [])
            assert.deepEqual(relay.messages, [])
            for (const command of ['AUTH', 'MAIL', 'RCPT', 'DATA'])
                assert.ok(!relay.commands.includes(command), command)
        }
    )
}

for (const mode of ['starttls', 'implicit'] as const) {
    test(
        `SMTP ${mode}: encrypted delivery preserves the exact password`,
        {
            timeout: 15_000
        },
        async (t) => {
            const relay = await createRelay(t, mode)
            await relay.send()
            assert.deepEqual(relay.auth, [
                {
                    encrypted: true,
                    value: '\0fixture-user\0  fixture password\t '
                }
            ])
            assert.equal(
                relay.commands.includes('STARTTLS'),
                mode === 'starttls'
            )
            assert.equal(relay.messages.length, 1)
            assert.match(relay.messages[0], /SMTP fixture body/)
        }
    )
}
