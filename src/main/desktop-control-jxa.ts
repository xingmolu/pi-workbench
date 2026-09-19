export type JxaExec = (
  file: string,
  args: readonly string[],
  options?: { timeout?: number; maxBuffer?: number; signal?: AbortSignal }
) => Promise<{ stdout: string | Buffer; stderr?: string | Buffer }>

export function stdoutText(value: string | Buffer): string {
  return typeof value === 'string' ? value : value.toString('utf8')
}

export async function runJxa(
  exec: JxaExec,
  source: string,
  signal?: AbortSignal
): Promise<unknown> {
  if (signal?.aborted) throw new Error('桌面控制操作已停止')
  const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', source], {
    timeout: 8000,
    maxBuffer: 512 * 1024,
    ...(signal ? { signal } : {})
  })
  const text = stdoutText(stdout).trim()
  return JSON.parse(text) as unknown
}

export const JXA_AX_DUMP = `function clip(value){var text=String(value==null?'':value);return text.length>80?text.slice(0,80):text}
function walk(el,depth,state){if(state.count>=80||depth>6){state.truncated=true;return null}state.count++;var node={role:'',title:'',value:'',description:'',x:null,y:null,width:null,height:null,children:[]};try{node.role=clip(el.role())}catch(e){}try{node.title=clip(el.title())}catch(e){}try{node.value=clip(el.value())}catch(e){}try{node.description=clip(el.description())}catch(e){}try{var p=el.position();node.x=p[0];node.y=p[1]}catch(e){}try{var s=el.size();node.width=s[0];node.height=s[1]}catch(e){}if(depth<6&&state.count<80){var kids=[];try{kids=el.uiElements()}catch(e){kids=[]}for(var i=0;i<kids.length;i++){if(state.count>=80){state.truncated=true;break}if(node.children.length>=24){state.truncated=true;break}var child=walk(kids[i],depth+1,state);if(child)node.children.push(child)}}return node}
function run(){var se=Application('System Events');var procs=se.processes.whose({frontmost:true});if(!procs.length)return JSON.stringify({ok:false,error:'no-frontmost'});var proc=procs[0];var state={count:0,truncated:false};var windows=[];try{var ws=proc.windows();for(var i=0;i<Math.min(ws.length,4);i++){var w=walk(ws[i],1,state);if(w)windows.push(w)}}catch(e){}var app='';var bundleId='';try{app=clip(proc.name())}catch(e){}try{bundleId=clip(proc.bundleIdentifier())}catch(e){}return JSON.stringify({ok:true,app:app,bundleId:bundleId,windows:windows,nodeCount:state.count,truncated:state.truncated})}`

export const JXA_SESSION_LOCK = `ObjC.import('Quartz');function run(){try{var dict=$.CGSessionCopyCurrentDictionary();if(!dict)return JSON.stringify({ok:true,locked:false});var value=dict.objectForKey('CGSSessionScreenIsLocked');var locked=!(!value||!value.boolValue);return JSON.stringify({ok:true,locked:locked})}catch(e){return JSON.stringify({ok:false,locked:true,error:String(e)})}}`

export function jxaClick(x: number, y: number, button: 'left' | 'right'): string {
  const px = Math.trunc(x)
  const py = Math.trunc(y)
  const down = button === 'right' ? '$.kCGEventRightMouseDown' : '$.kCGEventLeftMouseDown'
  const up = button === 'right' ? '$.kCGEventRightMouseUp' : '$.kCGEventLeftMouseUp'
  const btn = button === 'right' ? '$.kCGMouseButtonRight' : '$.kCGMouseButtonLeft'
  return `ObjC.import('CoreGraphics');function run(){var x=${px};var y=${py};var pt=$.CGPointMake(x,y);$.CGWarpMouseCursorPosition(pt);var moved=$.CGEventCreateMouseEvent(null,$.kCGEventMouseMoved,pt,0);$.CGEventPost($.kCGHIDEventTap,moved);var down=$.CGEventCreateMouseEvent(null,${down},pt,${btn});var up=$.CGEventCreateMouseEvent(null,${up},pt,${btn});$.CGEventPost($.kCGHIDEventTap,down);$.CGEventPost($.kCGHIDEventTap,up);return JSON.stringify({ok:true,x:x,y:y})}`
}

export function jxaMove(x: number, y: number): string {
  const px = Math.trunc(x)
  const py = Math.trunc(y)
  return `ObjC.import('CoreGraphics');function run(){var x=${px};var y=${py};var pt=$.CGPointMake(x,y);$.CGWarpMouseCursorPosition(pt);var moved=$.CGEventCreateMouseEvent(null,$.kCGEventMouseMoved,pt,0);$.CGEventPost($.kCGHIDEventTap,moved);return JSON.stringify({ok:true,x:x,y:y})}`
}

export function jxaType(text: string): string {
  const escaped = JSON.stringify(text)
  return `function run(){var se=Application('System Events');se.keystroke(${escaped});return JSON.stringify({ok:true})}`
}

