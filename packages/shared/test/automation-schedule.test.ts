import assert from 'node:assert/strict'
import test from 'node:test'
import {
    automationPresetRrule,
    automationRruleTime,
    automationRruleWeekday
} from '../src/automation-schedule'

// The web's schedule picker and the CLI's --schedule-preset both build
// their rules here.

test('each preset stands for one rule', () => {
    assert.equal(
        automationPresetRrule('daily', '09:00', 'MO'),
        'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0'
    )
    assert.equal(
        automationPresetRrule('hourly', '17:15', 'MO'),
        'RRULE:FREQ=HOURLY;INTERVAL=1;BYMINUTE=15;BYSECOND=0'
    )
    assert.equal(
        automationPresetRrule('weekdays', '08:30', 'MO'),
        'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=30;BYSECOND=0'
    )
    assert.equal(
        automationPresetRrule('weekly', '18:05', 'FR'),
        'RRULE:FREQ=WEEKLY;BYDAY=FR;BYHOUR=18;BYMINUTE=5;BYSECOND=0'
    )
})

test('a rule reads back its time and first weekday', () => {
    const weekly = 'RRULE:FREQ=WEEKLY;BYDAY=TH,FR;BYHOUR=7;BYMINUTE=5'
    assert.equal(automationRruleTime(weekly), '07:05')
    assert.equal(automationRruleWeekday(weekly), 'TH')
    assert.equal(automationRruleTime('FREQ=HOURLY'), '09:00')
    assert.equal(automationRruleWeekday('FREQ=WEEKLY;BYDAY=XX'), 'MO')
})
