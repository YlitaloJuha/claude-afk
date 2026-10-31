import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf, SessionStartInput, TurnCompleteInput } from 'claude-code'

import { DONE_MARK, MAX_TURNS, isForbidden, kickoff, nudge } from '../hooks/register'

const session: SessionStartInput = { surface: 'desktop', isInteractive: true, cwd: '/work' }

type AnsweredTurn = Exclude<TurnCompleteInput, { reason: 'refusal' }>
let turns = 0
const turn = (over: Partial<AnsweredTurn> = {}): TurnCompleteInput => ({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't' + ++turns, reason: 'answer', ...over })
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } as const })

const props: RenderPropsOf['AbovePrompt'] = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 75, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const mount = { plugin: 'afk', surface: 'desktop', component: 'AbovePrompt', props } as const

function world(on: On, percentUsed = 10, commands: string[] = []) {
  const prompts: string[] = []
  const ran: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000 }, rateLimits: [{ kind: 'five_hour', percentUsed }] } }))
  on('prompt.submit', ($, e) => { prompts.push(e.text); return { text: e.text } })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', ($, e) => { ran.push(e.tool); return { result: {} } })
  on('command.list', () => ({ value: commands.map(name => ({ name, description: '', source: 'plugin' as const })) }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: ['beneath'] }))
  return { prompts, ran }
}

async function start($: Parameters<Parameters<typeof test>[1]>[0], clock: { advance: (ms: number) => Promise<void> }, mode = 'test') {
  await $.session.start(session)
  await $.command.run({ command: 'afk', args: mode })
  await clock.advance(5)
}

const workedTurn = async ($: Parameters<Parameters<typeof test>[1]>[0], clock: { advance: (ms: number) => Promise<void> }, over: Partial<AnsweredTurn> = {}) => {
  await $.tool.call({ tool: 'Read', file_path: 'a' } as never)
  await $.turn.complete(turn(over))
  await clock.advance(5)
}

test('each mode has its own scope, and the rules forbid commits and questions', () => {
  for (const m of ['develop', 'test', 'refactor', 'housekeeping'] as const) {
    expect(kickoff(m)).toContain(`${m} mode`)
    expect(kickoff(m)).toContain('Do not commit, push')
    expect(kickoff(m)).toContain('Ask no questions')
    expect(kickoff(m)).toContain(DONE_MARK)
    expect(nudge(m)).toContain('Do not commit, push')
  }
  expect(kickoff('refactor')).not.toEqual(kickoff('test'))
})

test('the seatbelt catches the risky commands and leaves ordinary ones', () => {
  for (const c of ['git push', 'git push origin main', 'git commit -m x', 'git -C sub push', 'git reset --hard', 'git clean -fd', 'gh pr create', 'npm publish', 'rm -rf build', 'cd a && git push']) {
    expect(isForbidden(c)).toBe(true)
  }
  for (const c of ['git status', 'git diff', 'git log --oneline', 'npm test', 'rm file.txt', 'echo push', 'ls -la']) {
    expect(isForbidden(c)).toBe(false)
  }
})

test('off by default: nothing is sent and nothing is refused', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start(session)
  const r = await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
  expect(r.deny).toBeUndefined()
  await $.turn.complete(turn())
  await clock.advance(5)
  expect(w.prompts).toEqual([])
})

test('a press from idle sends the rules at once', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($, clock)
  expect(w.prompts).toEqual([kickoff('test')])
})

test('it keeps going after each turn', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($, clock)
  await workedTurn($, clock)
  await workedTurn($, clock)
  expect(w.prompts).toEqual([kickoff('test'), nudge('test'), nudge('test')])
})

test('a press during a turn reaches it on the next tool result, once', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start(session)
  await $.turn.start({ text: 'working', turnId: 'running' } as never)
  await $.command.run({ command: 'afk', args: 'refactor' })
  await clock.advance(5)
  expect(w.prompts).toEqual([])
  const first = await $.tool.call({ tool: 'Read', file_path: 'a' } as never)
  expect(first.context?.[0]).toContain('refactor mode')
  const second = await $.tool.call({ tool: 'Read', file_path: 'b' } as never)
  expect(second.context).toBeUndefined()
})

test('typing a message means you are back', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($, clock)
  await $.prompt.submit(typed('I am back'))
  await workedTurn($, clock)
  expect(w.prompts).toEqual([kickoff('test'), 'I am back'])
})

test('the Wrap up button ends it', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($, clock)
  await $.prompt.submit({ text: 'checklist', wait: false, origin: { kind: 'plugin', name: 'wrap-up' } })
  await workedTurn($, clock)
  expect(w.prompts).toEqual([kickoff('test'), 'checklist'])
})

test('another mod\'s prompt does not end it', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($, clock)
  await $.prompt.submit({ text: 'other', wait: false, origin: { kind: 'plugin', name: 'other-mod' } })
  await workedTurn($, clock)
  expect(w.prompts).toEqual([kickoff('test'), 'other', nudge('test')])
})

test('the done mark ends it', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($, clock)
  await workedTurn($, clock, { answer: `All done.\n${DONE_MARK}\n` })
  expect(w.prompts).toEqual([kickoff('test')])
})

test('an interrupt ends it', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($, clock)
  await workedTurn($, clock, { isAborted: true, reason: 'aborted' })
  expect(w.prompts).toEqual([kickoff('test')])
})

test('two turns without tools end it', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($, clock)
  await $.turn.complete(turn())
  await clock.advance(5)
  await $.turn.complete(turn())
  await clock.advance(5)
  expect(w.prompts).toEqual([kickoff('test'), nudge('test')])
})

test('the turn limit ends it', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($, clock)
  for (let i = 0; i < MAX_TURNS + 5; i++) await workedTurn($, clock)
  expect(w.prompts.length).toBe(MAX_TURNS)
})

test('a plan limit near its end stops it', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, 95)
  await start($, clock)
  await workedTurn($, clock)
  expect(w.prompts).toEqual([kickoff('test')])
})

test('while on, questions and forbidden commands are refused, in subagents too', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($, clock)
  expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)).deny).toContain('AFK')
  expect((await $.tool.call({ tool: 'Bash', command: 'git push' } as never)).deny).toContain('AFK')
  expect((await $.tool.call({ tool: 'Bash', command: 'git push', agentId: 'A1' } as never)).deny).toContain('AFK')
  expect((await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)).deny).toBeUndefined()
  expect(w.ran).toEqual(['Bash'])
})

test('Off stops it', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($, clock)
  await $.command.run({ command: 'afk', args: 'off' })
  await workedTurn($, clock)
  expect(w.prompts).toEqual([kickoff('test')])
})

test('on its own it draws a menu, and a mode starts the work', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start(session)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const each = await $.ui.mount({ ...mount, surface })
    expect(await each.find({ key: 'afk' })).toBeDefined()
    await each.unmount()
  }
  const ui = await $.ui.mount(mount)
  expect(await ui.find({ key: 'afk-test' })).toBeUndefined()
  await ui.press({ key: 'afk' })
  await ui.press({ key: 'afk-test' })
  await clock.advance(5)
  expect(w.prompts).toEqual([kickoff('test')])
})

test('with the bars mod it leaves the controls to that line', async ($, on) => {
  mock.clock(on)
  world(on, 10, ['bars'])
  await $.session.start(session)
  const ui = await $.ui.mount(mount)
  expect(await ui.find({ key: 'afk' })).toBeUndefined()
})

test('/afk names the modes and refuses an unknown one', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start(session)
  expect((await $.command.run({ command: 'afk' })).text).toContain('housekeeping')
  await $.command.run({ command: 'afk', args: 'nonsense' })
  await clock.advance(5)
  expect(w.prompts).toEqual([])
})
