export type Mode = 'off' | 'develop' | 'test' | 'refactor' | 'housekeeping'

declare module 'claude-code' {
  interface EngineInterface {
    afk: { choose: (args: { mode: Mode }) => Promise<void> }
  }

  interface PluginState {
    afk: {
      mode: Mode
      /** Turns taken since the mode was chosen. */
      taken: number
      /** Turns in a row that called no tool. */
      idleTurns: number
      toolCalls: number
      isNoticeDue: boolean
      isMenuOpen: boolean
    }
  }
}
