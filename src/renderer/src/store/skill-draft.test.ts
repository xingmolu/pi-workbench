import { expect, test, afterEach } from 'vitest'
import { insertSkillDraft, skillSlashQuery, useSkillInsertion } from './skill-draft'
import type { SkillInsertion } from './skill-draft'
const request: SkillInsertion = {
  identity: { project: '/fixture', sessionId: 's', generation: 1 },
  skill: {
    id: 'c9557759-94b9-4943-a25f-084bf742f419',
    name: 'example',
    description: '',
    scope: 'project',
    origin: 'top-level',
    mode: 'manual-only',
    canInsert: true
  }
}
afterEach(() => {
  useSkillInsertion.getState().consume()
})
test('insertion prepends a native command preserving the latest draft exactly', () => {
  expect(insertSkillDraft('existing\n text ', request, request.identity)).toBe(
    '/skill:example existing\n text '
  )
})
test('insertion refuses changed project, session, generation and ambiguous names', () => {
  for (const identity of [
    null,
    { ...request.identity, project: '/other' },
    { ...request.identity, sessionId: 'other' },
    { ...request.identity, generation: 2 }
  ])
    expect(insertSkillDraft('keep', request, identity)).toBeNull()
  expect(
    insertSkillDraft(
      'keep',
      { ...request, skill: { ...request.skill, canInsert: false } },
      request.identity
    )
  ).toBeNull()
  expect(
    insertSkillDraft(
      'keep',
      { ...request, skill: { ...request.skill, name: 'bad\ncommand' } },
      request.identity
    )
  ).toBeNull()
})
test('an insertion intent can be consumed exactly once', () => {
  useSkillInsertion.getState().request(request)
  expect(useSkillInsertion.getState().consume()).toEqual(request)
  expect(useSkillInsertion.getState().consume()).toBeNull()
})
test('slash selection consumes only the current query and preserves its task suffix', () => {
  expect(insertSkillDraft('/example', { ...request, queryPrefix: '/exa' }, request.identity)).toBeNull()
  expect(skillSlashQuery('/')).toEqual({ query: '', prefix: '/' })
  expect(skillSlashQuery('/skill:exa')).toEqual({ query: 'exa', prefix: '/skill:exa' })
  expect(skillSlashQuery('/exa Keep text')).toEqual({ query: 'exa', prefix: '/exa ' })
  expect(skillSlashQuery('/skill:example Keep text')).toBeNull()
  expect(
    insertSkillDraft('/exa Keep text', { ...request, queryPrefix: '/exa ' }, request.identity)
  ).toBe('/skill:example Keep text')
  expect(
    insertSkillDraft('/different Keep text', { ...request, queryPrefix: '/exa ' }, request.identity)
  ).toBeNull()
})
