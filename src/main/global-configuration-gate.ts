import { HostRejectedError } from './host-response-broker'

/** Shared auth/model/MCP files may change only while every resident is quiescent. */
export class GlobalConfigurationGate {
  private active = false
  private readonly uncertainOwners = new Set<string>()
  constructor(private readonly allIdle: () => boolean) {}
  get busy(): boolean {
    return this.active || this.uncertainOwners.size > 0
  }
  recordFailure(owner: string, error: unknown): void {
    if (!(error instanceof HostRejectedError)) this.uncertainOwners.add(owner)
  }
  ownerExited(owner: string): void {
    this.uncertainOwners.delete(owner)
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active) throw new Error('全局配置正在更新，请稍后重试')
    if (this.uncertainOwners.size) throw new Error('全局配置操作完成状态未确认，请先结束对应进程')
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
