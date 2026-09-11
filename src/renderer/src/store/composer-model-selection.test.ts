import { describe, expect, it } from 'vitest'
import {
  composerModelSelectionReducer,
  initialComposerModelSelection,
  modelSelectionCommand,
  newSessionCommand
} from './composer-model-selection'

describe('composer account staging', () => {
  it.each([null, 'provider-a'])(
    'follows a confirmed provider change from %s without explicit staging',
    (provider) => {
      const initial = initialComposerModelSelection({
        generation: 4,
        sessionId: 'session-a',
        activeProvider: provider
      })
      const synced = composerModelSelectionReducer(initial, {
        type: 'snapshot:sync',
        generation: 4,
        sessionId: 'session-a',
        activeProvider: 'provider-b'
      })
      expect(synced.stagedProvider).toBe('provider-b')
      expect(
        composerModelSelectionReducer(synced, {
          type: 'snapshot:sync',
          generation: 4,
          sessionId: 'session-a',
          activeProvider: 'provider-c'
        }).stagedProvider
      ).toBe('provider-c')
    }
  )

  it('preserves deliberate account browsing until its selection is confirmed', () => {
    const initial = initialComposerModelSelection({
      generation: 4,
      sessionId: 'session-a',
      activeProvider: 'provider-a'
    })
    const staged = composerModelSelectionReducer(initial, {
      type: 'provider:stage',
      providerId: 'provider-b'
    })
    const background = composerModelSelectionReducer(staged, {
      type: 'snapshot:sync',
      generation: 4,
      sessionId: 'session-a',
      activeProvider: 'provider-c'
    })
    expect(background.stagedProvider).toBe('provider-b')
    const confirmed = composerModelSelectionReducer(background, {
      type: 'snapshot:sync',
      generation: 4,
      sessionId: 'session-a',
      activeProvider: 'provider-b'
    })
    expect(confirmed.stagedProvider).toBe('provider-b')
    expect(
      composerModelSelectionReducer(confirmed, {
        type: 'snapshot:sync',
        generation: 4,
        sessionId: 'session-a',
        activeProvider: 'provider-d'
      }).stagedProvider
    ).toBe('provider-d')
  })

  it('stages account browsing locally without producing a host command', () => {
    const initial = initialComposerModelSelection({
      generation: 4,
      sessionId: 'session-a',
      activeProvider: 'openai-codex-work'
    })

    const staged = composerModelSelectionReducer(initial, {
      type: 'provider:stage',
      providerId: 'openai-codex-personal'
    })

    expect(staged).toEqual({
      generation: 4,
      sessionId: 'session-a',
      activeProvider: 'openai-codex-work',
      stagedProvider: 'openai-codex-personal'
    })
    expect(staged).not.toHaveProperty('command')
  })

  it('resets the staged provider when the host switches session generation', () => {
    const staged = {
      generation: 4,
      sessionId: 'session-a',
      activeProvider: 'openai-codex-work',
      stagedProvider: 'openai-codex-personal'
    }

    expect(
      composerModelSelectionReducer(staged, {
        type: 'snapshot:sync',
        generation: 5,
        sessionId: 'session-b',
        activeProvider: 'openai-codex-work'
      })
    ).toEqual({
      generation: 5,
      sessionId: 'session-b',
      activeProvider: 'openai-codex-work',
      stagedProvider: 'openai-codex-work'
    })
  })
})

describe('composer model action', () => {
  it('sets the exact combination in an empty session', () => {
    expect(modelSelectionCommand('openai-codex-work', 'gpt-5.6-sol')).toEqual({
      type: 'model:set',
      providerId: 'openai-codex-work',
      modelId: 'gpt-5.6-sol'
    })
  })

  it('keeps the current session and its transcript when selecting another model', () => {
    expect(modelSelectionCommand('openai-codex-work', 'gpt-5.6-luna')).toEqual({
      type: 'model:set',
      providerId: 'openai-codex-work',
      modelId: 'gpt-5.6-luna'
    })
  })
})

describe('sidebar new session action', () => {
  it('follows the exact active model only while that model is available', () => {
    expect(
      newSessionCommand({
        activeProvider: 'openai-codex-work',
        activeModel: 'gpt-5.6-sol',
        modelAvailability: 'available'
      })
    ).toEqual({
      type: 'session:new',
      providerId: 'openai-codex-work',
      modelId: 'gpt-5.6-sol'
    })
  })

  it.each([
    ['unavailable model', 'openai-codex-work', 'gpt-5.6-sol', 'unavailable'],
    ['disconnected account', 'openai-codex-personal', 'gpt-5.6-sol', 'unavailable'],
    ['no explicit model', null, null, 'unselected']
  ] as const)(
    'starts locked without inherited identity for %s',
    (_, provider, model, availability) => {
      expect(
        newSessionCommand({
          activeProvider: provider,
          activeModel: model,
          modelAvailability: availability
        })
      ).toEqual({ type: 'session:new' })
    }
  )
})
