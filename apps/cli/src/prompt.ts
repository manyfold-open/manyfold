import { createInterface } from 'node:readline/promises'

// Enter alone means yes, as in the other [Y/n] prompts.
export const promptYesNo = async (question: string): Promise<boolean> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
        const answer = (await rl.question(question)).trim().toLowerCase()
        return answer === '' || answer.startsWith('y')
    } finally {
        rl.close()
    }
}
