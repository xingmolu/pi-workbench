/** Shared auth/model/MCP files may change only while every resident is quiescent. */
export class GlobalConfigurationGate {
  private active = false
  constructor(private readonly allIdle: () => boolean) {}
  get busy(): boolean {
    return this.active
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active) throw new Error('全局配置正在更新，请稍后重试')
    if (!this.allIdle())
      throw new Error('请先结束所有会话的运行、队列、审批、编辑或登录，再修改全局配置')
    this.active = true
    try {
      return await operation()
    } finally {
      this.active = false
    }
  }
}
