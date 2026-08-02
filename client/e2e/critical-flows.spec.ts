import { expect, test } from '@playwright/test';

const enableAuthenticatedSession = async (page: import('@playwright/test').Page) => {
  await page.addInitScript(() => {
    localStorage.setItem('chatllm.auth-session-hint:v1', JSON.stringify({ hasLoggedIn: true }));
    localStorage.setItem('chatllm.current-project-space:v1', '11111111-1111-4111-8111-111111111111');
  });
};

test('local login reaches the authenticated workspace', async ({ page }) => {
  await page.goto('/login');
  await page.locator('#auth-email').fill('e2e@example.com');
  await page.locator('#auth-password').fill('correct-horse-battery-staple');
  await page.getByTestId('auth-submit').click();

  await expect(page).toHaveURL('/');
  await expect(page.getByTestId('conversation-browser-trigger')).toBeVisible();
});

test('chat sends a message and renders the SSE answer', async ({ page }) => {
  await enableAuthenticatedSession(page);
  await page.goto('/');
  await page.getByTestId('conversation-browser-trigger').click();
  await page.getByTestId('conversation-22222222-2222-4222-8222-222222222222').click();
  await page.getByTestId('chat-input').fill('Explain the source evidence');
  await page.getByTestId('chat-send').click();

  await expect(page.getByText('The streamed E2E answer is complete.')).toBeVisible();
});

test('knowledge upload reports completion and refreshes the file list', async ({ page }) => {
  await enableAuthenticatedSession(page);
  await page.goto('/knowledge');
  await page.getByTestId('knowledge-file-input').setInputFiles({
    name: 'uploaded-e2e.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Uploaded through browser E2E'),
  });

  await expect(page.getByTestId('knowledge-file-55555555-5555-4555-8555-555555555555')).toContainText('uploaded-e2e.md');
});

test('citation opens the converted document preview', async ({ page }) => {
  await enableAuthenticatedSession(page);
  await page.goto('/');
  await page.getByTestId('conversation-browser-trigger').click();
  await page.getByTestId('conversation-22222222-2222-4222-8222-222222222222').click();
  await page.getByTestId('source-initial-assistant-message-0').click();

  await expect(page.getByRole('dialog')).toContainText('E2E source document');
  await expect(page.getByRole('dialog')).toContainText('citation preview loaded converted Markdown');
});

test('knowledge graph shows only evidence facts with quality lane and source detail', async ({ page }) => {
  await enableAuthenticatedSession(page);
  await page.goto('/rag-graph');

  await expect(page.getByTestId('graph-extraction-status')).toContainText(/规则|fallback/i);
  await page.getByTestId('graph-fact-kgfact_e2e_depends').click();
  await expect(page.getByText('订单服务不依赖 Redis。', { exact: true })).toBeVisible();
  await expect(page.getByText(/negative/)).toBeVisible();

  await page.getByTestId('graph-fact-kgfact_e2e_connects').click();
  await expect(page.getByText('订单服务计划连接到 Kafka。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /打开原文证据|Open source evidence/i }).click();
  await expect(page.getByRole('dialog')).toContainText(/原始文件定位：第 7 行|Original file location: Lines? 7/i);
  await expect(page.getByRole('dialog')).toContainText('citation preview loaded converted Markdown');
});
