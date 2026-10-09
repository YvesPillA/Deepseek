import {mountOuterEntry} from './outer-link.mjs';
import {scopeOf,scopeChainOf} from '@deepseek-ai/dsh-scope';
export const name='foreman-next-outer';
export const inject=['foremanNext','tools','systemPrompt','userQuestions'];
export async function apply(ctx){
  const scope=scopeOf(ctx);
  if(!scope)throw new Error('Foreman outer entry requires an agent or standing preset scope');
  await mountOuterEntry(ctx,{contains:agent=>scopeChainOf(scopeOf(agent.ctx)).includes(scope)});
}
