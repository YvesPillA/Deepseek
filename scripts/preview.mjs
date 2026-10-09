// Offline UI fixture only. No DSH host, project store or model is started.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {initialState,transition} from '../src/core.mjs';
import {dashboardSnapshot} from '../src/dashboard.mjs';
const requireDsh=createRequire(path.join(process.env.DSH_TEST_INSTALL??'C:/example/dsh/node/node_modules/@deepseek-ai/dsh','package.json'));
const requireLocal=createRequire(new URL('../package.json',import.meta.url));
const requireClient=name=>name==='react'||name.startsWith('react-dom/')?requireLocal(name):requireDsh(name);
const React=requireLocal('react'),{renderToStaticMarkup}=requireLocal('react-dom/server');
let client;
vm.runInNewContext(await fs.readFile(new URL('../client/index.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load:m=>client=m.factory(requireClient)}}});
let state=transition(initialState(),{role:'user'},{type:'create',id:'demo',objective:'读书清单 · 本地应用',workspace:'D:/Demo/reading-list',reviewers:[
  {id:'function',name:'功能监督',responsibility:'功能与需求覆盖',criteria:'可以新增、编辑和删除书籍；支持按阅读状态筛选；重新打开仍保留数据。'},
  {id:'quality',name:'质量监督',responsibility:'代码与测试',criteria:'关键行为有可复现的验证证据；错误输入不会破坏已有数据。'},
  {id:'experience',name:'体验监督',responsibility:'交互与可访问性',criteria:'键盘可完成核心操作；窄屏没有横向溢出；错误提示明确。'},
]});
const manager={role:'coordinator',project:'demo'};
const command=(actor,c)=>{state=transition(state,actor,{project:'demo',...c});};
const vote=pass=>{const r=Object.values(state.projects.demo.rounds).at(-1);for(const reviewer of ['function','quality','experience'])command({role:'reviewer',project:'demo',reviewer},{type:'vote',round:r.id,generation:r.generation,pass,findings:pass?'方案覆盖已锁定要求。':'缺少异常输入的验证证据，请补充。'});};
command(manager,{type:'propose',definition:{id:'data',title:'数据与持久保存',criteria:'读书记录可保存并恢复',deps:[]}});vote(true);
command(manager,{type:'task',milestone:'data',id:'storage',title:'实现本地存储',instructions:'保存并恢复读书记录'});
command(manager,{type:'assign',task:'storage',agentId:'worker'});command({role:'executor',project:'demo',id:'worker'},{type:'complete',task:'storage',result:'已实现本地存储'});
for(let i=0;i<3;i++){command(manager,{type:'submit',milestone:'data',artifact:'preview-fixture'});vote(false);}
command(manager,{type:'propose',definition:{id:'interface',title:'书籍管理界面',criteria:'支持新增编辑与状态筛选',deps:['data']}});vote(true);
command(manager,{type:'propose',definition:{id:'guide',title:'使用说明',criteria:'提供清晰的启动与使用步骤',deps:[]}});vote(true);
const data=dashboardSnapshot(state,{readyForProjects:false});
const body=renderToStaticMarkup(React.createElement(client.ForemanView,{data,selected:'demo'}));
// Use installed host styles, including its actual reset and light/dark tokens.
// The main slot supplies no padding. Previous preview body padding hid this bug.
const packageDir=name=>path.dirname(requireDsh.resolve(name));
const bundle=async name=>fs.readFile(path.join(packageDir(name),'client.js'),'utf8');
const nativeSource=await bundle('@deepseek-ai/dsh-client-ui-plugin-manager');
const nativeCss=JSON.parse(nativeSource.match(/const css = ("(?:\\.|[^"\\])*");/)[1]);
const nativePrefix=nativeCss.match(/\.([\w]+)_page\{/)[1];
const themeSource=await bundle('@deepseek-ai/dsh-client-ui-theme');
const themeCss=[...themeSource.matchAll(/var \w+_css_default = ("(?:\\.|[^"\\])*");/g)].map(m=>JSON.parse(m[1])).join('\n');
const frontendAssets=path.join(packageDir('@deepseek-ai/dsh-client-ui-theme'),'..','..','dsh-web-frontend','dist','assets');
const frontendCss=await fs.readFile(path.join(frontendAssets,(await fs.readdir(frontendAssets)).find(n=>/^index-.*\.css$/.test(n))),'utf8');
const panelMarkup=renderToStaticMarkup(React.createElement(client.ForemanPanel,{load:async()=>data}));
const emptyBody=renderToStaticMarkup(React.createElement(client.ForemanView,{data:dashboardSnapshot(initialState(),{readyForProjects:true})}));
const nativeHeader=`<section class="${nativePrefix}_page"><header class="${nativePrefix}_pageHead"><div><h2 class="${nativePrefix}_pageTitle">原生插件页</h2><p class="${nativePrefix}_pageIntro">原生标题与说明</p></div></header></section>`;
const html=`<!doctype html><html lang="zh-CN" data-platform="win32"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>新工头模式 · 离线布局对照</title>
<style>${frontendCss}\n${themeCss}\n${nativeCss}\n${client.css}
.fixture-slot{position:absolute;left:280px;right:0;top:38px;bottom:0;display:flex;flex-direction:column;min-width:0;overflow:hidden}.fixture-native{visibility:hidden}.fixture-native,.fixture-native>section{height:100%}.fixture-slot [data-slot]{display:contents}
</style><body><div class="fixture-slot fixture-native">${nativeHeader}</div><div class="fixture-slot"><div data-slot="main">${panelMarkup}</div></div>
<template id="project">${body}</template><template id="empty">${emptyBody}</template>
<script>
const q=s=>document.querySelector(s),mode=new URLSearchParams(location.search).get('mode')||'project';
if(mode.includes('dark'))document.body.setAttribute('data-ds-dark-theme','');
if(mode.includes('narrow'))q('.fixture-slot:not(.fixture-native)').style.left='0px';
q('.fmn-content').replaceChildren(q(mode.includes('empty')?'#empty':'#project').content.cloneNode(true));
const measure=s=>{const e=q(s),r=e.getBoundingClientRect(),c=getComputedStyle(e);return {x:r.x,y:r.y,width:r.width,height:r.height,fontFamily:c.fontFamily,fontSize:c.fontSize,fontWeight:c.fontWeight,lineHeight:c.lineHeight,color:c.color,background:c.backgroundColor,overflow:c.overflow,padding:c.padding}};
const result={mode,viewport:{width:innerWidth,height:innerHeight},native:measure('.${nativePrefix}_pageTitle'),nativeIntro:measure('.${nativePrefix}_pageIntro'),panel:measure('.fmn-panel'),title:measure('.fmn-panel h2'),intro:measure('.fmn-panel>header .fmn-muted'),content:measure('.fmn-content'),heading:measure('.fmn-content h3'),body:measure('.fmn-content p'),scroll:{clientHeight:q('.fmn-panel').clientHeight,scrollHeight:q('.fmn-panel').scrollHeight,clientWidth:q('.fmn-panel').clientWidth,scrollWidth:q('.fmn-panel').scrollWidth}};
const report=document.createElement('pre');report.id='layout-result';report.textContent=JSON.stringify(result);report.hidden=true;document.body.append(report);
</script></body></html>`;
const target=new URL('../artifacts/dashboard-preview.html',import.meta.url);await fs.mkdir(new URL('../artifacts/',import.meta.url),{recursive:true});await fs.writeFile(target,html);
console.log('Saved '+target.pathname);
if(process.argv.includes('--serve')){
  const server=http.createServer(async(_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');try{res.end(await fs.readFile(target));}catch{res.statusCode=500;res.end('Preview is unavailable');}});
  server.listen(43187,'127.0.0.1',()=>console.log('Preview: http://127.0.0.1:43187'));
}
