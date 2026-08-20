import {
    createCipheriv,
    createDecipheriv,
    randomBytes,
    type CipherGCM,
    type DecipherGCM
} from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

export interface EncryptedValue {
    ciphertext: string
    keyVersion: number
}

const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32

@Injectable()
export class CryptoService {
    private readonly keys: Map<number, Buffer>
    private readonly currentVersion: number

    constructor(config: ConfigService) {
        const primary = config.get<string>('API_CRYPTO_KEY')
        if (!primary) throw new Error('API_CRYPTO_KEY is required')
        this.keys = new Map()
        this.currentVersion = 1
        this.keys.set(1, decodeKey(primary, 'API_CRYPTO_KEY'))

        const legacy = config.get<string>('API_CRYPTO_KEY_V0')
        if (legacy) this.keys.set(0, decodeKey(legacy, 'API_CRYPTO_KEY_V0'))
    }

    encrypt(plain: string): EncryptedValue {
        const key = this.keys.get(this.currentVersion)!
        const iv = randomBytes(IV_LEN)
        const cipher = createCipheriv(ALGO, key, iv) as CipherGCM
        const encrypted = Buffer.concat([
            cipher.update(plain, 'utf8'),
            cipher.final()
        ])
        const tag = cipher.getAuthTag()
        const packed = Buffer.concat([iv, tag, encrypted]).toString('base64')
        return { ciphertext: packed, keyVersion: this.currentVersion }
    }

    decrypt(value: EncryptedValue): string {
        const key = this.keys.get(value.keyVersion)
        if (!key)
            throw new Error(
                `no crypto key registered for version ${value.keyVersion}`
            )
        const raw = Buffer.from(value.ciphertext, 'base64')
        if (raw.length < IV_LEN + TAG_LEN)
            throw new Error('ciphertext too short')
        const iv = raw.subarray(0, IV_LEN)
        const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN)
        const data = raw.subarray(IV_LEN + TAG_LEN)
        const decipher = createDecipheriv(ALGO, key, iv) as DecipherGCM
        decipher.setAuthTag(tag)
        return Buffer.concat([
            decipher.update(data),
            decipher.final()
        ]).toString('utf8')
    }
}

const decodeKey = (raw: string, label: string): Buffer => {
    const buf = Buffer.from(raw, 'base64')
    if (buf.length !== KEY_LEN)
        throw new Error(
            `${label} must be base64-encoded ${KEY_LEN} bytes (got ${buf.length})`
        )
    return buf
}
