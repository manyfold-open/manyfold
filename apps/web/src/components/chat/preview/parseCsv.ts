// RFC4180 state machine; lenient on malformed input (an unterminated quote
// consumes to EOF as the final field) so preview rendering never throws
export const parseCsv = (text: string): string[][] => {
    const input = text.startsWith('\ufeff') ? text.slice(1) : text
    const rows: string[][] = []
    let row: string[] = []
    let field = ''
    let inQuotes = false
    let i = 0
    const endField = (): void => {
        row.push(field)
        field = ''
    }
    const endRow = (): void => {
        endField()
        rows.push(row)
        row = []
    }
    while (i < input.length) {
        const char = input[i]
        if (inQuotes) {
            if (char === '"') {
                if (input[i + 1] === '"') {
                    field += '"'
                    i += 2
                    continue
                }
                inQuotes = false
                i += 1
                continue
            }
            field += char
            i += 1
            continue
        }
        if (char === '"' && field === '') {
            inQuotes = true
            i += 1
            continue
        }
        if (char === ',') {
            endField()
            i += 1
            continue
        }
        if (char === '\r') {
            endRow()
            i += input[i + 1] === '\n' ? 2 : 1
            continue
        }
        if (char === '\n') {
            endRow()
            i += 1
            continue
        }
        field += char
        i += 1
    }
    if (field !== '' || row.length > 0 || inQuotes) endRow()
    return rows
}