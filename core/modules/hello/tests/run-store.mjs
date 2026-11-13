import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHelloRepository } from '../../../../app/shared/storage/hello/repository.js'
const root=await mkdtemp(join(tmpdir(),'hello-'))
try {
 const path=join(root,'state.json'),r=createHelloRepository({path});assert.equal(await r.read(),null)
 const s={schemaVersion:1,flowVersion:'hello-v1',entryKind:'new',step:'welcome',dingtalk:{status:'not_started'},revision:0,status:'draft',draft:{name:'鱼',prompt:'',perceptionRequested:null,abs:{timeScale:1,restHours:{enabled:true,start:'23:00',end:'08:00'}}},operations:[]}
 await r.write(s,null);assert.equal((await stat(path)).mode & 0o777,0o600)
 const results=await Promise.allSettled([r.write({...s,revision:1},0),r.write({...s,revision:1},0)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1)
 await writeFile(path,'{broken');await assert.rejects(r.read(),/CORRUPT_STATE/);await assert.rejects(r.write(s,1),/CORRUPT_STATE/)
} finally {await rm(root,{recursive:true,force:true})}
console.log('hello repository tests passed')
