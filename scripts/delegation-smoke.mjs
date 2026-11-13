// Opt-in trial with real local models. Only creates goals through the product;
// owner creation, work and delivery must be performed by the concierge/owners.
import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { completeAutonomySetup } from "./lib/autonomy-setup.mjs";

const exec = promisify(execFile);
const trial = await realpath(await mkdtemp("/tmp/cv-delegate-"));
const workspace = join(trial, "workspace"), home = join(trial, "home");
const session = `crewvane-trial-${randomUUID().slice(0, 8)}`;
const trialAgent = process.env.CREWVANE_TRIAL_AGENT ??
  "omp";
await mkdir(workspace); await mkdir(home);
await writeFile(join(workspace, "AGENTS.md"), `# 隔离产品验收
只处理本工作区目标，不访问其他项目或用户文件，不提交、发布或发送外部消息。
目标实际执行必须由独立负责人完成，管家只负责分发、协调与向人交接。
交付检查必须实际运行，不得编造。负责人须记录自己真实的 HERDR_PANE_ID。
`);
let app, page;
const errors = [];
async function snapshot() { return page.evaluate(() => window.crewvane.command({type:"snapshot"})); }
async function capture(label) {
  const current = await snapshot();
  await writeFile(join(trial, `${label}-state.json`), JSON.stringify(current, null, 2));
  const diagnostics = await app.evaluate(async (_electron, session) => {
    const { execFile } = process.getBuiltinModule("node:child_process");
    const run = args => new Promise(resolve => execFile("herdr", ["--session", session, ...args],
      {timeout:10_000,maxBuffer:512_000}, (error, stdout, stderr) => resolve({error:error?.message,stdout,stderr})));
    const listed = await run(["agent","list"]);
    let entries = [];
    try { const data = JSON.parse(listed.stdout); entries = data.result?.agents ?? data.agents ?? []; } catch {}
    return { listed, transcripts: await Promise.all(entries.map(async agent => ({
      name:agent.name, paneId:agent.pane_id,
      read:await run(["agent","read",agent.name || agent.pane_id,"--source","visible","--lines","40"]),
    }))) };
  }, session);
  await writeFile(join(trial, `${label}-agents.json`), JSON.stringify(diagnostics, null, 2));
  await page.screenshot({path:join(trial,`${label}.png`),animations:"disabled"});
  return diagnostics;
}
try {
  app = await electron.launch({
    executablePath:resolve(process.env.CREWVANE_APP_PATH || "apps/desktop/release/Crewvane-darwin-arm64/Crewvane.app/Contents/MacOS/Crewvane"),
    env:{...process.env,CREWVANE_TEST_HOME:home,CREWVANE_TEST_USER_DATA:join(trial,"userData"),
      CREWVANE_TEST_WORKSPACE:workspace,CREWVANE_HERDR_SESSION:session},
    timeout:60_000,
  });
  page = await app.firstWindow();
  page.on("pageerror", error => errors.push(String(error)));
  await completeAutonomySetup(page);
  await expect.poll(async () => (await page.evaluate(() => window.crewvane.environment())).workspace).toBe(workspace);
  await page.evaluate(preferences => window.crewvane.command({type:"agents.configure",preferences}), {
    concierge:trialAgent, owner:trialAgent, worker:trialAgent,
  });
  const ids = [];
  for (const marker of ["ALPHA_READY","BETA_READY"]) {
    const goal = await page.evaluate(({marker,workspace}) => window.crewvane.command({type:"goal.create",input:{
      title:`交付 ${marker}`,projectId:"personal",mode:"concierge",
      description:`在 ${workspace}/${marker}.json 写入 JSON，包含 marker="${marker}" 和 executorPane（执行者进程环境中的真实 HERDR_PANE_ID）。${marker === "ALPHA_READY" ? "这个目标附带一张测试图片，实际读取案卷中 attachment 指定的原图，确认是 PNG，并在成果中附上它的 SHA-256；不得声称看过却没有读取。" : ""}实际运行一个读取此文件并断言 marker 与非空 executorPane 的命令，再提交成果位置和真实检查记录供我验收。不要只回复文字。只操作此隔离工作区，无需提交或发布。`,
    }}),{marker,workspace});
    ids.push(goal.id);
  }
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
    picture = join(trial, "owner-evidence.png");
  await writeFile(picture, png);
  await exec("pnpm", ["--dir", "cli", "exec", "tsx", "src/main.ts", "direct",
    "请按案卷附带的图片验证真实附件传递", "--goal", ids[0], "--attachment", picture, "--root", workspace, "--json"]);
  console.log(JSON.stringify({step:"two-goals-created",trial,session,ids,trialAgent}));
  const start = Date.now();
  let inspected = 0, current;
  while (Date.now() - start < 600_000) {
    current = await snapshot();
    const selected = current.goals.filter(goal => ids.includes(goal.id));
    if (selected.every(goal => goal.status === "review")) break;
    if (Math.floor((Date.now()-start)/60_000) > inspected) {
      inspected++;
      await capture(`minute-${inspected}`);
      console.log(JSON.stringify({step:"waiting",minute:inspected,goals:selected.map(goal=>({
        id:goal.id,status:goal.status,dispatch:goal.dispatch?.status,pane:goal.scene?.locator.paneId,
        question:goal.attention?.summary,
      }))}));
    }
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  const goals = current.goals.filter(goal=>ids.includes(goal.id));
  assert.ok(goals.every(goal=>goal.status==="review"),"both goals must reach review through real owners");
  assert.equal(new Set(goals.map(goal=>goal.scene?.locator.paneId)).size,2,"each goal has a distinct owner pane");
  for (const [index,marker] of ["ALPHA_READY","BETA_READY"].entries()) {
    const goal = goals.find(goal=>goal.id===ids[index]);
    assert.equal(goal.scene?.backend, "herdr");
    assert.ok(goal.scene.locator.paneId && goal.scene.locator.tabId);
    assert.equal(goal.scene.locator.session,session);
    assert.notEqual(goal.scene.locator.paneId,current.concierge.scene.locator.paneId);
    assert.notEqual(goal.scene.locator.tabId,current.concierge.scene.locator.tabId);
    const delivered = JSON.parse(await readFile(join(workspace,`${marker}.json`),"utf8"));
    assert.equal(delivered.marker,marker);
    assert.equal(delivered.executorPane,goal.scene.locator.paneId,"the actual executor is the registered owner, not concierge");
    assert.ok(goal.delivery.checks.length && goal.delivery.checks.every(check=>check.result==="passed"));
    if (marker === "ALPHA_READY") {
      assert.equal(goal.attachments.length, 1);
      const evidence = await readFile(join(workspace, goal.attachments[0].path));
      assert.ok(evidence.equals(png), "the owner received the actual image stored in the goal");
      assert.match(JSON.stringify(goal.delivery), /[a-f0-9]{64}/);
    }
  }
  await page.evaluate(()=>window.crewvane.openTerminal());
  await page.getByRole("region",{name:"Herdr 工作现场"}).waitFor();
  const diagnostics = await capture("two-real-owners");
  const data = JSON.parse(diagnostics.listed.stdout), agents = data.result?.agents ?? data.agents;
  assert.equal(agents.length,3,"two goals have exactly two owners and one concierge, without duplicate starts");
  assert.equal(agents.filter(agent=>agent.pane_id===current.concierge.scene.locator.paneId).length,1);
  assert.ok(goals.every(goal=>agents.some(agent=>agent.pane_id===goal.scene.locator.paneId)));
  const directGoal = goals.at(-1), dispatchBeforeDirect = directGoal.dispatch?.id,
    directMarker = `DIRECT_TERMINAL_${randomUUID().slice(0, 8)}`;
  const directPrompt = await app.evaluate(async (_electron, {session,directMarker,currentConciergePane}) => {
    const { execFile } = process.getBuiltinModule("node:child_process");
    return await new Promise(resolve => execFile("herdr", [
      "--session", session, "agent", "prompt", currentConciergePane,
      `这是用户直接发给你的 Herdr 终端消息。按你的身份协议，只把原话同步回 Crewvane 当前目标，不要开始新的执行或创建负责人。原话：追加下一步 ${directMarker}`,
      "--wait", "--timeout", "180000",
    ], {timeout:190_000,maxBuffer:512_000}, (error, stdout, stderr) =>
      resolve({error:error?.message,stdout,stderr})));
  }, {session,directMarker,currentConciergePane:current.concierge.scene.locator.paneId});
  assert.equal(directPrompt.error, undefined, directPrompt.stderr || directPrompt.error);
  await expect.poll(async () => {
    const state = await snapshot();
    return state.goals.find(goal => goal.id === directGoal.id)?.activities
      .some(activity => activity.text.includes(directMarker));
  }, {timeout:180_000}).toBe(true);
  const directState = await snapshot();
  const syncedDirect = directState.goals.find(goal => goal.id === directGoal.id);
  assert.equal(syncedDirect.dispatch?.id, dispatchBeforeDirect,
    "a terminal direct message must not create a duplicate handoff");
  const directActivity = syncedDirect.activities.find(activity =>
    activity.text.includes(directMarker));
  assert.equal(directActivity?.actor, "你 · Herdr 直聊");
  console.log(JSON.stringify({step:"direct-terminal-synced",goalId:directGoal.id,directMarker}));
  const newTaskMarker = `DIRECT_NEW_${randomUUID().slice(0, 8)}`;
  const newTaskPrompt = await app.evaluate(async (_electron, {session,newTaskMarker,currentConciergePane}) => {
    const { execFile } = process.getBuiltinModule("node:child_process");
    return await new Promise(resolve => execFile("herdr", [
      "--session", session, "agent", "prompt", currentConciergePane,
      `这是用户通过 Herdr 终端直接发来的独立新任务。严格只执行下面两步，不创建负责人，不做其他任务：
1. 运行 crewvane direct --new "直接终端新任务 ${newTaskMarker}" --json
2. 从返回 JSON 读取 id，运行 crewvane goal progress <id> --summary "已直接受理终端新任务" --next "整理完成标准并创建负责人" --json
完成后简短回复。`,
      "--wait", "--timeout", "180000",
    ], {timeout:190_000,maxBuffer:512_000}, (error, stdout, stderr) =>
      resolve({error:error?.message,stdout,stderr})));
  }, {session,newTaskMarker,currentConciergePane:current.concierge.scene.locator.paneId});
  assert.equal(newTaskPrompt.error, undefined, newTaskPrompt.stderr || newTaskPrompt.error);
  let directNew;
  await expect.poll(async () => {
    const state = await snapshot();
    directNew = state.goals.find(goal => goal.title.includes(newTaskMarker));
    return directNew?.activities.some(activity =>
      activity.text.includes("已直接受理终端新任务")) ?? false;
  }, {timeout:180_000}).toBe(true);
  assert.equal(directNew.dispatch?.status, "sent",
    "a directly received new task must not be replayed to the concierge");
  assert.ok(directNew.activities.some(activity => activity.actor === "你 · Herdr 直聊"));
  assert.equal(directNew.next, "整理完成标准并创建负责人",
    "the concierge must be able to keep working on the direct-created goal");
  console.log(JSON.stringify({step:"direct-terminal-new-goal-synced",goalId:directNew.id,newTaskMarker}));
  await app.close();
  app = await electron.launch({
    executablePath:resolve(process.env.CREWVANE_APP_PATH || "apps/desktop/release/Crewvane-darwin-arm64/Crewvane.app/Contents/MacOS/Crewvane"),
    env:{...process.env,CREWVANE_TEST_HOME:home,CREWVANE_TEST_USER_DATA:join(trial,"userData"),
      CREWVANE_TEST_WORKSPACE:workspace,CREWVANE_HERDR_SESSION:session},timeout:60_000,
  });
  page = await app.firstWindow();
  page.on("pageerror",error=>errors.push(String(error)));
  await expect.poll(async()=> (await page.evaluate(()=>window.crewvane.environment())).workspace).toBe(workspace);
  await page.evaluate(()=>window.crewvane.prepareConcierge());
  const restored = await snapshot();
  assert.equal(restored.concierge.scene.locator.paneId,current.concierge.scene.locator.paneId,"resuming refreshes the existing concierge without replacing it");
  assert.deepEqual(restored.goals.filter(goal=>ids.includes(goal.id)).map(goal=>goal.scene.locator),goals.map(goal=>goal.scene.locator));
  const resumed=await capture("resumed-roles");
  const resumedData=JSON.parse(resumed.listed.stdout);
  assert.equal((resumedData.result?.agents ?? resumedData.agents).length,3);
  await page.evaluate(goalId => window.crewvane.command({
    type:"goal.accept",goalId,actor:"你",
  }),goals[0].id);
  await expect.poll(async()=> (await snapshot()).goals.find(goal=>goal.id===goals[0].id)?.scene)
    .toBe(undefined);
  const afterClose = await capture("first-owner-closed"),
    remaining = JSON.parse(afterClose.listed.stdout).result?.agents ?? [];
  assert.equal(remaining.length,2,"acceptance closes one owner, preserving the concierge and the other goal");
  assert.ok(remaining.some(agent=>agent.pane_id===current.concierge.scene.locator.paneId));
  assert.ok(remaining.some(agent=>agent.pane_id===goals[1].scene.locator.paneId));
  await page.evaluate(goalId => window.crewvane.command({
    type:"goal.accept",goalId,actor:"你",
  }),goals[1].id);
  await expect.poll(async()=> (await snapshot()).goals.find(goal=>goal.id===goals[1].id)?.scene)
    .toBe(undefined);
  await page.evaluate(goalId => window.crewvane.command({
    type:"goal.delete",goalId,actor:"你",
  }),goals[1].id);
  const afterDelete = await capture("second-owner-closed");
  assert.equal((JSON.parse(afterDelete.listed.stdout).result?.agents ?? []).length,1,
    "permanent deletion closes its owner and preserves only the global concierge");
  assert.equal((await snapshot()).goals.some(goal=>goal.id===goals[1].id),false);
  assert.equal((await snapshot()).concierge.scene.locator.paneId,current.concierge.scene.locator.paneId);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,trial,session,checks:[
    "two desktop goals create two independent real owners","one global concierge",
    "actual outputs identify each owner pane","real checks and delivery",
    "direct Herdr terminal message writes back without duplicate dispatch",
    "direct Herdr new task writes back and advances the concierge case scope",
    "restart refreshes concierge role and preserves both owner references",
    "real image attachment reaches an owner and is included in delivery evidence",
    "acceptance closes only each corresponding owner tab; permanent deletion removes the ended goal",
  ]}));
} catch (error) {
  if (app && page) await capture("failure").catch(()=>{});
  console.error(JSON.stringify({trial,session,error:String(error),errors}));
  throw error;
} finally {
  if (app) {
    await app.evaluate(async(_electron,session)=>{
      const {execFile}=process.getBuiltinModule("node:child_process");
      await new Promise(resolve=>execFile("herdr",["--session",session,"server","stop"],{timeout:10_000},()=>resolve()));
    },session).catch(()=>{});
    await app.close().catch(()=>{});
  }
  if (process.env.CREWVANE_KEEP_TEST_ARTIFACTS!=="1") await rm(trial,{recursive:true,force:true});
}
