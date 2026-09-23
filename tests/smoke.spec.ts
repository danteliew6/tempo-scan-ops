import { test, expect } from '@playwright/test';

// Smoke tests are intentionally loose on copy (exact headings evolve) and assert on
// the Tempo Scan brand, nav, and that each route renders without crashing.

test('home renders the Tempo Scan shell + Operations Hub', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/Tempo Scan/i).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /Operations Hub/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /Sovereignty & Governance/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /Document Intelligence/i })).toBeVisible();
});

test('Command Center loads', async ({ page }) => {
  await page.goto('/command');
  await expect(page.locator('body')).toBeVisible();
});

test('Demand & Inventory Forecast (the star) loads', async ({ page }) => {
  await page.goto('/forecast');
  await expect(page.locator('body')).toBeVisible();
});

test('Sovereignty & Governance page loads', async ({ page }) => {
  await page.goto('/access');
  await expect(page.locator('body')).toBeVisible();
});

test('Ask Tempo (Genie) page loads', async ({ page }) => {
  await page.goto('/ask');
  await expect(page.getByText(/Ask Tempo/i).first()).toBeVisible();
});

test('Document Intelligence page loads', async ({ page }) => {
  await page.goto('/documents');
  await expect(page.getByText(/Document Intelligence/i).first()).toBeVisible();
});

test('AI/BI Dashboard page loads', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.locator('body')).toBeVisible();
});

test('Architecture page loads', async ({ page }) => {
  await page.goto('/architecture');
  await expect(page.locator('body')).toBeVisible();
});
