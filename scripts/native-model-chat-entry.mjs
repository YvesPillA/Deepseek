import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export const nativeModelChatTitle='新工头聊天入口验收';
export const nativeModelChatWelcome='新工头聊天入口已就绪。这条欢迎消息由本地确定性 fixture 生成，未调用模型 API。请在此会话输入项目需求。';

// Preserve the complete production outer prompt and append fixture limits to
// that same section. 0.2 intentionally ignores any other ordinary sections
// when one complete prompt is active. Services and identity remain host-owned.
export function nativeModelFixtureComposerContext(ctx,work) {
  const prompt=ctx.get('systemPrompt');
  const fixtureText='本次隔离联调的唯一项目 ID 是 chat，workspace 固定为 '+work.replaceAll('\\','/')+'。开局 create 的 id 必须为 chat；其他请求的 project 必须为 chat。接收普通聊天需求，先建议各管一方面的监督名单，再通过 foreman_user_request 的原生确认卡锁定开局。监督验收全部通过后，最终交付仍须原生确认。不得选择其他项目或目录。';
  return {
    get agent(){return ctx.agent;},
    get(name){return name==='systemPrompt'?{section(section){
      assert.equal(section.name,'foreman:outer');assert.equal(section.complete,true);assert.equal(typeof section.text,'string');
      return prompt.section({...section,text:section.text+'\n'+fixtureText});
    }}:ctx.get(name);},
    effect:(...args)=>ctx.effect(...args),
    on:(...args)=>ctx.on(...args),
  };
}

// A standalone surface append remains blank in 0.2 and has no conversation
// turn coordinates. Let the actual AgentLoop own a local welcome turn before
// enabling paid middleware or the scheduler. Never invent turn events.
export async function initializeNativeModelChat(ctx,agent) {
  assert.equal(ctx.get('agents').get(agent.id),agent);
  assert.equal(agent.status,'idle');
  assert(!agent.session.snapshotEvents().some(event=>event.type==='turn/start'),'Welcome requires a fresh outer session');
  ctx.get('sessionTitle').rename(agent.session,nativeModelChatTitle);
  let replies=0;
  const dispose=ctx.on('llm/stream',async function*(){
    assert.equal(++replies,1,'Welcome must make exactly one local model turn');
    yield {type:'block-start',index:0,blockType:'text'};
    yield {type:'block-end',index:0,block:{type:'text',text:nativeModelChatWelcome}};
    yield {type:'finish',reason:{kind:'stop'}};
  });
  try {
    agent.followup({id:randomUUID(),role:'user',content:[{type:'text',text:'本地入口初始化：等待用户输入项目需求。此消息仅用于隔离 fixture 的零 API 欢迎回合。'}],source:{kind:'plugin:foreman-native-model-ui'}});
    await agent.whenIdle();
    assert.equal(replies,1);
    const events=agent.session.snapshotEvents();
    assert.equal(events.filter(event=>event.type==='turn/start').length,1);
    assert.equal(events.findLast(event=>event.type==='turn/end')?.data.reason.kind,'completed');
    assert(events.some(event=>event.type==='assistant/message'&&event.data.message.content.some(block=>block.type==='text'&&block.text===nativeModelChatWelcome)));
    assert.equal(await ctx.get('sessions').flush(agent.session),true);
    return {seedingTurns:replies,title:nativeModelChatTitle};
  } finally {dispose();}
}
