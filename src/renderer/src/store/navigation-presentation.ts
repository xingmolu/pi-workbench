import type { NavigationLibraryState } from '../../../shared/navigation-library'
import {
  comparePinned,
  projectDisplayName,
  projectIsHidden,
  sessionIsArchived
} from '../../../shared/navigation-library'
import { sessionTaskTreeRows, type LiveProject, type LiveSessionRow } from './live-projects'

export function needsAttention(session: LiveSessionRow): boolean {
  return Boolean(session.workerId && ['running', 'awaiting-approval'].includes(session.status))
}
export function presentNavigationProjects(
  projects: LiveProject[],
  library: NavigationLibraryState
): LiveProject[] {
  return projects
    .filter(
      (project) => !projectIsHidden(library, project.path) || project.sessions.some(needsAttention)
    )
    .map((project) => {
      const sessions = project.sessions
        .filter(
          (session) =>
            !session.path || !sessionIsArchived(library, session.path) || needsAttention(session)
        )
        .map((session) => ({
          ...session,
          pinned: Boolean(session.path && library.sessions[session.path]?.pinnedAt !== undefined)
        }))
        .sort((left, right) =>
          comparePinned(
            left.path ? library.sessions[left.path] : undefined,
            right.path ? library.sessions[right.path] : undefined
          )
        )
      return {
        ...project,
        name: projectDisplayName(library, project.path, project.name),
        sessions: sessionTaskTreeRows(sessions)
      }
    })
    .sort((left, right) => comparePinned(library.projects[left.path], library.projects[right.path]))
}
