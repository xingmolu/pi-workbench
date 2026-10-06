import { expect, type Page } from '@playwright/test'

export async function openWorkbenchTool(page: Page, title: string): Promise<void> {
  const expand = page.getByRole('button', { name: '展开工作台', exact: true })
  if (await expand.isVisible()) await expand.click()
  // Tabs are found by tool, since each browser page is a tab named after its page.
  const tool = page.locator(`.workbench-tab[data-tool="${title}"]`)
  if (await tool.count()) {
    if (!(await tool.and(page.locator('[data-active="true"]')).count()))
      await tool.first().getByRole('tab').click()
    return
  }
  const launcher = page.getByRole('navigation', { name: '打开工作台工具' })
  if (await launcher.isVisible())
    await launcher.getByRole('button', { name: title, exact: true }).click()
  else {
    await page.getByRole('button', { name: '打开工具', exact: true }).click()
    await page.getByRole('menuitem', { name: title, exact: true }).click()
  }
  await expect(tool.and(page.locator('[data-active="true"]'))).toHaveCount(1)
}
