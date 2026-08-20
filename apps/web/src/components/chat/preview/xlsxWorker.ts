// Parses untrusted .xlsx bytes off the main thread; the owning component
// terminates this worker if parsing exceeds PREVIEW_PARSE_TIMEOUT_MS.
// Imports are static: the iife worker bundle must stay a single chunk
import * as excelJsNamespace from 'exceljs'
import type { Workbook, Worksheet } from 'exceljs'
import {
    SHEET_MAX_COLS,
    SHEET_MAX_ROWS,
    cellText
} from './previewKinds'

export interface SheetSnapshot {
    name: string
    rows: string[][]
    truncated: boolean
}

export type XlsxWorkerResponse =
    | { ok: true; sheets: SheetSnapshot[] }
    | { ok: false; message: string }

interface ExcelJsModule {
    Workbook: new () => Workbook
}

// exceljs ships a CJS/UMD browser bundle; depending on how the bundler
// interops it, the module surface is either the namespace or .default
const ExcelJS: ExcelJsModule =
    (excelJsNamespace as unknown as { default?: ExcelJsModule }).default ??
    (excelJsNamespace as unknown as ExcelJsModule)

const snapshotSheet = (sheet: Worksheet): SheetSnapshot => {
    const rows: string[][] = []
    let truncated = false
    sheet.eachRow((row) => {
        if (rows.length >= SHEET_MAX_ROWS) {
            truncated = true
            return
        }
        const cells: string[] = []
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            if (colNumber > SHEET_MAX_COLS) return
            cells[colNumber - 1] = cellText(cell.value)
        })
        rows.push(Array.from(cells, (value) => value ?? ''))
    })
    return { name: sheet.name, rows, truncated }
}

self.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
    let response: XlsxWorkerResponse
    try {
        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(event.data)
        response = { ok: true, sheets: workbook.worksheets.map(snapshotSheet) }
    } catch (err) {
        response = {
            ok: false,
            message: err instanceof Error ? err.message : String(err)
        }
    }
    self.postMessage(response)
}