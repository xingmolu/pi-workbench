import { expect, type Page } from '@playwright/test'

export async function openWorkbenchTool(page: Page, title: string): Promise<void> {
  const expand = page.getByRole('button', { name: '展开工作台', exact: true })
  if (await expand.isVisible()) await expand.click()
  const tab = page.getByRole('tab', { name: title, exact: true })
  if (await tab.count()) {
    await tab.click()
    return
  }
  const launcher = page.getByRole('navigation', { name: '打开工作台工具' })
  if (await launcher.isVisible())
    await launcher.getByRole('button', { name: title, exact: true }).click()
  else {
    await page.getByRole('button', { name: '打开工具', exact: true }).click()
    await page.getByRole('menuitem', { name: title, exact: true }).click()
  }
  await expect(page.getByRole('tab', { name: title, exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  )
}
