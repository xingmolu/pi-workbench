import { expect, it } from 'vitest'
import { readProjectCatalog } from './project-catalog'

it('reports the project cap and returns disjoint session pages through an injected read-only boundary',async()=>{
  const session = (cwd:string,index:number) => ({cwd,id:String(index),path:`/agent/sessions/${index}.jsonl`,created:new Date(0),modified:new Date(index*1000),messageCount:1,firstMessage:`title ${index}`,allMessagesText:'private transcript'})
  const sessions = [...Array.from({length:52},(_,index)=>session('/a',index)),...Array.from({length:101},(_,index)=>session(`/project-${index}`,index+100))]
  const options = {agentDir:'/agent',manager:{listAll:async()=>sessions},recentPaths:['/a'],directories:async()=>[],normalize:async(path:string)=>path}
  const catalog = await readProjectCatalog(options)
  expect(catalog.projects).toHaveLength(100)
  expect(catalog.totalProjects).toBe(102)
  expect(catalog.truncated).toBe(true)
  expect(catalog.projects[0].sessions).toHaveLength(50)
  expect(catalog.projects[0].nextOffset).toBe(50)
  const more = await readProjectCatalog({...options,cwd:'/a',offset:50})
  expect(more.projects[0].sessions.map(session=>session.id)).toEqual(['1','0'])
  expect(more.projects[0].nextOffset).toBe(null)
  expect(JSON.stringify(catalog)).not.toContain('private transcript')
})
