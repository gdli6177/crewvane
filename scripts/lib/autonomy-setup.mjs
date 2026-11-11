export async function completeAutonomySetup(
  page,
  option = "human-review",
) {
  const dialog = page.getByRole("dialog", {
    name: "交付完成后，谁来验收？",
  });
  await dialog.waitFor({ state: "visible" });
  const label = option === "auto-with-verification"
    ? /独立复核后自动验收/
    : /每次都由我验收/;
  await dialog.getByRole("button", { name: label }).click();
  await dialog.waitFor({ state: "hidden" });
}
