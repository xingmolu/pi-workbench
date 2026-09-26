# Pi Desktop

Pi Desktop 让用户在工作区内与 Agent 协作，并管理可恢复的对话、后台任务和宿主能力。

## Language

**Session（会话）**：可恢复的对话历史及其上下文。会话可以暂时没有运行实例。

**Resident worker（驻留运行实例）**：当前承载会话并能接受操作的运行实例。
_Avoid_：用“会话”同时指代持久历史和当前运行实例。

**Foreground selection（前台选择）**：用户当前在桌面查看和操作的驻留会话。改变前台选择不等于结束后台工作。

**Agent runtime provider（Agent 运行时）**：负责执行 Agent 行为的系统，例如 Pi。
_Avoid_：用“模型供应商”指代运行时。

**Model provider（模型供应商）**：提供语言模型访问能力的来源。同一个 Agent 运行时可以使用不同模型供应商。

**Host capability（宿主能力）**：由桌面宿主管理、可供 Agent 通过受约束请求使用的操作能力，例如浏览器和电脑操作。

**Session task（会话任务）**：由父会话委派、可跟踪并收集结果的后台工作。其执行不隐式改变用户的前台选择。
