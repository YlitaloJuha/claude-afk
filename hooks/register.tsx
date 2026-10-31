// AFK: choose a mode from the bars mod's menu or with /afk. A mode sends the session
// its rules and keeps it going turn after turn until the work runs out, a limit is
// reached or the person types again. The rules travel in the prompts, not the system
// prompt, so choosing a mode does not break the prompt cache.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Mode } from '../types'

export const MAX_TURNS = 30
export const MAX_IDLE_TURNS = 2
export const MAX_LIMIT_PERCENT = 90
export const DONE_MARK = 'AFK-DONE'

export const MODES: Array<{ mode: Mode; label: string }> = [
  { mode: 'off', label: 'Off' },
  { mode: 'develop', label: 'Develop' },
  { mode: 'test', label: 'Test' },
  { mode: 'refactor', label: 'Refactor' },
  { mode: 'housekeeping', label: 'Housekeeping' },
]

const SCOPES: Record<Exclude<Mode, 'off'>, string> = {
  develop: 'Build what is already planned: take the next item from this project\'s plan, task list, specs or TODOs and implement it, with tests. Do not invent features or change the design.',
  test: 'Improve the tests: run the suite, add tests for what is uncovered, and repair failing tests. Change production code only to fix a real bug a test exposed, and report each one.',
  refactor: 'Improve the code without changing behaviour: small steps, tests green before and after each. Change no public interface and add no features.',
  housekeeping: 'Tidy up: bring docs, CLAUDE.md and comments in line with the code, remove dead code and stale TODOs, fix lint warnings. List outdated dependencies without upgrading them.',
}

const RULES = `The user is away and nobody will answer until they return.

Rules:
- Stay in this project and follow its CLAUDE.md and the user's own instructions.
- Do not commit, push, open pull requests, publish, deploy or message anyone. Leave changes in the working tree.
- Do nothing destructive or hard to undo, and do not touch credentials.
- Ask no questions. Note a decision that is the user's, then take the reversible option or move on.
- Work in small steps and run the relevant tests after each. Keep the project's progress tracker current if it has one.
- If a step fails twice, note it and move on.
- When nothing useful is left in this mode, or you are blocked, report what changed, what you left and every open question. End that reply with a last line of exactly ${DONE_MARK}.`

export function kickoff(mode: Exclude<Mode, 'off'>): string {
  return `The user pressed the AFK button in ${mode} mode. Start now.\n\nThis mode: ${SCOPES[mode]}\n\n${RULES}`
}

export function nudge(mode: Exclude<Mode, 'off'>): string {
  return `AFK ${mode} mode continues. Take the next step.\n\nThis mode: ${SCOPES[mode]}\n\n${RULES}`
}

// Commands the rules forbid, refused here since a permission dialog would wait for
// someone who is away. A seatbelt: a command can be spelled past these patterns.
const FORBIDDEN = [
  /\bgit\b[^;&|]*\s(push|commit|clean)\b/,
  /\bgit\b[^;&|]*\sreset\b[^;&|]*--hard/,
  /\bgh\s+(pr\s+(create|merge)|release)\b/,
  /\b(npm|pnpm|yarn|cargo)\s+publish\b/,
  /\brm\s+-[a-zA-Z]*[rf]/,
]

export const isForbidden = (command: string) => FORBIDDEN.some(pattern => pattern.test(command))

// Prompts no person sent; any other origin means someone is back.
const UNATTENDED = new Set(['plugin', 'task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'coordinator', 'observer', 'observer-activity'])

const mode = atom({ plugin: 'afk', key: 'mode' } as const, 'off' as Mode)
const taken = atom({ plugin: 'afk', key: 'taken' } as const, 0)
const idleTurns = atom({ plugin: 'afk', key: 'idleTurns' } as const, 0)
const toolCalls = atom({ plugin: 'afk', key: 'toolCalls' } as const, 0)
const isNoticeDue = atom({ plugin: 'afk', key: 'isNoticeDue' } as const, false)

async function stop($: EngineInterface, why: string) {
  await update($, mode, () => 'off')
  await update($, isNoticeDue, () => false)
  $.ui.toast(`AFK off: ${why}`)
  $.ui.log(`AFK off: ${why}`)
}

let isWorking = false

async function choose($: EngineInterface, chosen: Mode) {
  await update($, mode, () => chosen)
  await update($, taken, () => 0)
  await update($, idleTurns, () => 0)
  await update($, toolCalls, () => 0)
  await update($, isNoticeDue, () => isWorking)
  // A running turn hears it on its next tool result and goes on from turn.complete.
  if (chosen !== 'off' && !isWorking) $.clock.after(1, () => $.prompt.submit({ text: kickoff(chosen) }))
}

export const register: Register = on => {
  // Adds `$.afk`, which the bars mod's AFK menu calls. A call is the `afk.choose`
  // event, answered below; the method itself is the chain's floor.
  on('engine.create', async ($, e, next) => {
    const built = await next(e)
    return { ...built, afk: { choose: async () => undefined } }
  })

  on('afk.choose', async ($, e) => ({ value: await choose($, e.mode) }))

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'afk', description: 'Keep working while you are away: develop, test, refactor, housekeeping or off', argumentHint: '[off | develop | test | refactor | housekeeping]', immediate: true })
    return result
  })

  on('command.run', { command: 'afk' }, async ($, e) => {
    const word = String(e.args ?? '').trim()
    const picked = MODES.find(m => m.mode === word)
    if (picked === undefined) return { text: `AFK is ${await read($, mode)}. Use /afk ${MODES.map(m => m.mode).join(' | ')}` }
    await choose($, picked.mode)
    return { text: `AFK ${picked.mode}` }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) isWorking = true
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const current = await read($, mode)
    if (current !== 'off') {
      if (e.tool === 'AskUserQuestion') {
        return { deny: 'AFK: the user is away. Note the question for your final report, then take the reversible option or move on.' }
      }
      if (e.tool === 'Bash' && isForbidden(String(e.command ?? ''))) {
        return { deny: 'AFK: this command is not allowed while the user is away. Leave it for their return and note it in your report.' }
      }
    }
    if (e.agentId === undefined) await update($, toolCalls, n => n + 1)
    const result = await next(e)
    if (e.agentId !== undefined || result.deny !== undefined || !(await read($, isNoticeDue))) return result
    await update($, isNoticeDue, () => false)
    const notice = current === 'off'
      ? 'The user turned AFK off. Their usual instructions apply again.'
      : `The user pressed the AFK button in ${current} mode.\n\nThis mode: ${SCOPES[current]}\n\n${RULES}`
    return { ...result, context: [...(result.context ?? []), notice] }
  })

  on('prompt.submit', async ($, e, next) => {
    if ((await read($, mode)) !== 'off') {
      const isWrapUp = e.origin.kind === 'plugin' && e.origin.name === 'wrap-up'
      if (isWrapUp) await stop($, 'wrapping up')
      else if (!UNATTENDED.has(e.origin.kind)) await stop($, 'you are back')
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) isWorking = false
    const current = await read($, mode)
    if (e.agentId !== undefined || current === 'off') return result
    if (e.isAborted || e.reason !== 'answer') return (await stop($, e.isAborted ? 'interrupted' : `the turn ended with ${e.reason}`), result)
    if (e.answer.trimEnd().endsWith(DONE_MARK)) return (await stop($, 'the session says it is finished or blocked'), result)
    const called = await read($, toolCalls)
    await update($, toolCalls, () => 0)
    const idle = called === 0 ? (await read($, idleTurns)) + 1 : 0
    await update($, idleTurns, () => idle)
    if (idle >= MAX_IDLE_TURNS) return (await stop($, 'two turns in a row did no work'), result)
    const count = (await read($, taken)) + 1
    await update($, taken, () => count)
    if (count >= MAX_TURNS) return (await stop($, `reached the limit of ${MAX_TURNS} turns`), result)
    const usage = await $.session.usage()
    const spent = usage.rateLimits.find(l => l.percentUsed >= MAX_LIMIT_PERCENT)
    if (spent !== undefined) return (await stop($, `${spent.kind} plan limit is at ${Math.round(spent.percentUsed)}%`), result)
    $.clock.after(1, () => $.prompt.submit({ text: nudge(current) }))
    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') await update($, mode, () => 'off')
    return next(e)
  })
}
