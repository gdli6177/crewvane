export async function completeAutonomySetup(
  page,
  option = "human-review",
) {
  const dialog = page.getByRole("dialog", {
    name: "交付完成后，谁来验收？",
  });
  if (await dialog.isVisible().catch(() => false)) {
    const label = option === "auto-with-verification"
      ? /独立复核后自动验收/
      : /每次都由我验收/;
    await dialog.getByRole("button", { name: label }).click();
    await dialog.waitFor({ state: "hidden" });
    return;
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const workspace = await page.evaluate(() =>
      window.crewvane.environment().then(value => value.workspace),
    );
    if (workspace) {
      await page.evaluate(acceptance => window.crewvane.command({
        type: "workspace.autonomy.set",
        acceptance,
        initialize: true,
        actor: "你",
      }), option);
      await page.waitForFunction(() =>
        window.crewvane.command({ type: "snapshot" })
          .then(state => Boolean(state.autonomy.initializedAt)),
      );
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("测试工作区未在 30 秒内打开，无法初始化自主设置");
}
