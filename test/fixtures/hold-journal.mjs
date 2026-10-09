import {JournalStore} from '../../src/store.mjs';
try {
  const store=await JournalStore.open(process.argv[2]);
  if(!store.snapshot().projects.p)await store.dispatch({role:'user'},{type:'create',id:'p',objective:'Crash recovery fixture',workspace:'D:/fixture',reviewers:[{id:'r',name:'Review',responsibility:'Quality',criteria:'Evidence required'}]});
  process.send({ready:true,revision:store.snapshot().revision});
  setInterval(()=>{},1000); // Parent intentionally kills this disposable fixture.
} catch(e){process.send({error:e.message},()=>process.exit(0));}
