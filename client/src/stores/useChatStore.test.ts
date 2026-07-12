import { beforeEach, describe, expect, test, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../lib/api', () => ({ default: apiMock }));
vi.mock('../i18n', () => ({
  default: { t: (key: string) => key },
}));

import { type Message, useChatStore } from './useChatStore';
import { chatRequestState } from './chatRequestState';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const message = (id: string, content: string, role: Message['role'] = 'assistant'): Message => ({
  id,
  role,
  content,
  created_at: `2026-07-13T00:00:0${id.length}.000Z`,
});

const resetStore = () => {
  useChatStore.setState({
    conversations: [],
    currentConversationId: null,
    messages: [],
    messagesCache: {},
    messagePagination: {},
    loadingConversations: false,
    loadingMessages: false,
    loadingOlderMessages: false,
    sendingMessage: false,
    isStopped: false,
    abortController: null,
  });
};

beforeEach(() => {
  chatRequestState.reset();
  resetStore();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('conversation request isolation', () => {
  test('out-of-order conversation fetches update only their captured cache and visible conversation', async () => {
    const first = deferred<{ data: Message[]; headers: Record<string, string> }>();
    const second = deferred<{ data: Message[]; headers: Record<string, string> }>();
    apiMock.get.mockImplementation((url: string) => (
      url.includes('/conversation-a/') ? first.promise : second.promise
    ));

    const selectA = useChatStore.getState().selectConversation('conversation-a');
    const selectB = useChatStore.getState().selectConversation('conversation-b');

    second.resolve({ data: [message('b', 'message B')], headers: {} });
    await selectB;
    first.resolve({ data: [message('a', 'message A')], headers: {} });
    await selectA;

    const state = useChatStore.getState();
    expect(state.currentConversationId).toBe('conversation-b');
    expect(state.messages.map((item) => item.content)).toEqual(['message B']);
    expect(state.messagesCache['conversation-a'].map((item) => item.content)).toEqual(['message A']);
    expect(state.messagesCache['conversation-b'].map((item) => item.content)).toEqual(['message B']);
  });

  test('a stale fetch generation cannot overwrite a newer fetch for the same conversation', async () => {
    const older = deferred<{ data: Message[]; headers: Record<string, string> }>();
    const newer = deferred<{ data: Message[]; headers: Record<string, string> }>();
    apiMock.get
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);

    const firstSelect = useChatStore.getState().selectConversation('conversation-a');
    const secondSelect = useChatStore.getState().selectConversation('conversation-a');

    newer.resolve({ data: [message('new', 'new response')], headers: {} });
    await secondSelect;
    older.resolve({ data: [message('old', 'stale response')], headers: {} });
    await firstSelect;

    expect(useChatStore.getState().messages.map((item) => item.content)).toEqual(['new response']);
    expect(useChatStore.getState().messagesCache['conversation-a'].map((item) => item.content))
      .toEqual(['new response']);
  });

  test('SSE updates remain in the originating conversation after switching away', async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      statusText: 'OK',
      body: stream,
    } as Response));
    vi.stubGlobal('fetch', fetchMock);
    apiMock.get.mockImplementation(async (url: string) => (
      url === '/chat/conversations'
        ? { data: [], headers: {} }
        : { data: [message('b', 'visible B')], headers: {} }
    ));

    const initialA = [message('a-seed', 'seed A')];
    useChatStore.setState({
      currentConversationId: 'conversation-a',
      messages: initialA,
      messagesCache: { 'conversation-a': initialA },
    });

    const send = useChatStore.getState().sendMessage('question A');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await useChatStore.getState().selectConversation('conversation-b');

    streamController.enqueue(new TextEncoder().encode('data: {"content":"answer A"}\n\n'));
    streamController.close();
    await send;

    const state = useChatStore.getState();
    expect(state.currentConversationId).toBe('conversation-b');
    expect(state.messages.map((item) => item.content)).toEqual(['visible B']);
    expect(state.messagesCache['conversation-a'].at(-1)?.content).toBe('answer A');
  });

  test('switching back to an active stream keeps its live cache instead of fetching stale history', async () => {
    const partial = [message('partial', 'live partial answer')];
    const activeController = chatRequestState.beginStream('conversation-a');
    apiMock.get.mockResolvedValue({ data: [message('stale', 'stale server copy')], headers: {} });
    useChatStore.setState({
      currentConversationId: 'conversation-b',
      messages: [],
      messagesCache: { 'conversation-a': partial, 'conversation-b': [] },
    });

    await useChatStore.getState().selectConversation('conversation-a');

    const state = useChatStore.getState();
    expect(apiMock.get).not.toHaveBeenCalled();
    expect(state.messages).toEqual(partial);
    expect(state.sendingMessage).toBe(true);
    expect(state.abortController).toBe(activeController);
  });

  test('creating a new conversation does not inherit another conversation stream state', async () => {
    const created = deferred<{ data: {
      id: string;
      title: string;
      created_at: string;
      updated_at: string;
    } }>();
    const activeController = chatRequestState.beginStream('conversation-a');
    apiMock.post.mockImplementation(() => created.promise);
    apiMock.get.mockResolvedValue({ data: [], headers: {} });
    useChatStore.setState({
      currentConversationId: 'conversation-a',
      sendingMessage: true,
      abortController: activeController,
      messages: [],
      messagesCache: { 'conversation-a': [] },
    });

    const create = useChatStore.getState().createConversation();
    const optimisticState = useChatStore.getState();
    expect(optimisticState.currentConversationId).toMatch(/^temp-/);
    expect(optimisticState.sendingMessage).toBe(false);
    expect(optimisticState.abortController).toBeNull();
    expect(chatRequestState.hasActiveStream('conversation-a')).toBe(true);

    created.resolve({
      data: {
        id: 'conversation-new',
        title: 'New',
        created_at: '2026-07-13T00:00:00.000Z',
        updated_at: '2026-07-13T00:00:00.000Z',
      },
    });
    await create;
  });

  test('stopGeneration aborts only the selected conversation stream', async () => {
    const requests: Array<{
      url: string;
      signal: AbortSignal;
      resolve: (response: Response) => void;
    }> = [];
    vi.stubGlobal('fetch', vi.fn((url: string | URL | Request, init?: RequestInit) => (
      new Promise<Response>((resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        requests.push({ url: String(url), signal, resolve });
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      })
    )));

    useChatStore.setState({
      currentConversationId: 'conversation-a',
      messages: [],
      messagesCache: { 'conversation-a': [], 'conversation-b': [] },
    });
    const sendA = useChatStore.getState().sendMessage('question A');
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    useChatStore.setState({ currentConversationId: 'conversation-b', messages: [] });
    const sendB = useChatStore.getState().sendMessage('question B');
    await vi.waitFor(() => expect(requests).toHaveLength(2));

    useChatStore.setState({
      currentConversationId: 'conversation-a',
      messages: useChatStore.getState().messagesCache['conversation-a'],
    });
    useChatStore.getState().stopGeneration();

    expect(requests[0].signal.aborted).toBe(true);
    expect(requests[1].signal.aborted).toBe(false);

    requests.forEach((request) => request.resolve({ ok: true, body: null } as Response));
    await Promise.all([sendA, sendB]);
  });

  test('a replaced stream cannot apply buffered SSE chunks to the same conversation', async () => {
    const streamControllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamControllers.push(controller);
        },
      });
      return { ok: true, statusText: 'OK', body: stream } as Response;
    }));
    let nextTimestamp = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nextTimestamp++);
    useChatStore.setState({
      currentConversationId: 'conversation-a',
      messages: [],
      messagesCache: { 'conversation-a': [] },
    });

    const olderSend = useChatStore.getState().sendMessage('older question');
    await vi.waitFor(() => expect(streamControllers).toHaveLength(1));
    const newerSend = useChatStore.getState().sendMessage('newer question');
    await vi.waitFor(() => expect(streamControllers).toHaveLength(2));

    streamControllers[0].enqueue(new TextEncoder().encode('data: {"content":"stale answer"}\n\n'));
    streamControllers[0].close();
    streamControllers[1].enqueue(new TextEncoder().encode('data: {"content":"current answer"}\n\n'));
    streamControllers[1].close();
    await Promise.all([olderSend, newerSend]);

    const contents = useChatStore.getState().messagesCache['conversation-a'].map((item) => item.content);
    expect(contents).toContain('current answer');
    expect(contents).not.toContain('stale answer');
  });

  test('successful conversation deletion aborts its stream before removing its cache', async () => {
    const request = deferred<Response>();
    let streamSignal!: AbortSignal;
    vi.stubGlobal('fetch', vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      streamSignal = init?.signal as AbortSignal;
      streamSignal.addEventListener('abort', () => {
        request.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, { once: true });
      return request.promise;
    }));
    apiMock.delete.mockResolvedValue({ data: { success: true } });
    useChatStore.setState({
      conversations: [{
        id: 'conversation-a',
        title: 'A',
        created_at: '2026-07-13T00:00:00.000Z',
        updated_at: '2026-07-13T00:00:00.000Z',
      }],
      currentConversationId: 'conversation-a',
      messages: [],
      messagesCache: { 'conversation-a': [] },
    });

    const send = useChatStore.getState().sendMessage('question A');
    await vi.waitFor(() => expect(streamSignal).toBeDefined());
    await useChatStore.getState().deleteConversation('conversation-a');
    const wasAborted = streamSignal.aborted;
    if (!wasAborted) request.resolve({ ok: true, body: null } as Response);
    await send;

    expect(wasAborted).toBe(true);
    expect(useChatStore.getState().messagesCache['conversation-a']).toBeUndefined();
    expect(chatRequestState.hasActiveStream('conversation-a')).toBe(false);
  });

  test('failed conversation deletion does not overwrite a newer selection or conversation list', async () => {
    const deleteRequest = deferred<never>();
    const messageA = message('a', 'message A');
    const messageB = message('b', 'message B');
    const conversationA = {
      id: 'conversation-a',
      title: 'A',
      created_at: '2026-07-13T00:00:00.000Z',
      updated_at: '2026-07-13T00:00:00.000Z',
    };
    const conversationB = {
      id: 'conversation-b',
      title: 'B',
      created_at: '2026-07-13T00:00:00.000Z',
      updated_at: '2026-07-13T00:00:00.000Z',
    };
    const conversationC = {
      id: 'conversation-c',
      title: 'C',
      created_at: '2026-07-13T00:00:00.000Z',
      updated_at: '2026-07-13T00:00:00.000Z',
    };
    apiMock.delete.mockImplementation(() => deleteRequest.promise);
    apiMock.get.mockResolvedValue({ data: [messageB], headers: {} });
    useChatStore.setState({
      conversations: [conversationA, conversationB],
      currentConversationId: 'conversation-a',
      messages: [messageA],
      messagesCache: {
        'conversation-a': [messageA],
        'conversation-b': [messageB],
      },
    });

    const deletion = useChatStore.getState().deleteConversation('conversation-a');
    useChatStore.setState((state) => ({
      conversations: [
        conversationC,
        ...state.conversations.map((conversation) => (
          conversation.id === 'conversation-b'
            ? { ...conversation, title: 'B renamed while delete was pending' }
            : conversation
        )),
      ],
    }));
    await useChatStore.getState().selectConversation('conversation-b');
    deleteRequest.reject(new Error('delete failed'));
    await deletion;

    const state = useChatStore.getState();
    expect(state.currentConversationId).toBe('conversation-b');
    expect(state.messages).toEqual([messageB]);
    expect(state.conversations.map((conversation) => conversation.id)).toEqual(
      expect.arrayContaining(['conversation-a', 'conversation-b', 'conversation-c']),
    );
    expect(state.conversations.find((conversation) => conversation.id === 'conversation-b')?.title)
      .toBe('B renamed while delete was pending');
  });

  test('failed deletion of the selected conversation restores its cached messages', async () => {
    const deleteRequest = deferred<never>();
    const cachedMessage = message('a', 'cached A');
    apiMock.delete.mockImplementation(() => deleteRequest.promise);
    useChatStore.setState({
      conversations: [{
        id: 'conversation-a',
        title: 'A',
        created_at: '2026-07-13T00:00:00.000Z',
        updated_at: '2026-07-13T00:00:00.000Z',
      }],
      currentConversationId: 'conversation-a',
      messages: [cachedMessage],
      messagesCache: { 'conversation-a': [cachedMessage] },
    });

    const deletion = useChatStore.getState().deleteConversation('conversation-a');
    deleteRequest.reject(new Error('delete failed'));
    await deletion;

    const state = useChatStore.getState();
    expect(state.currentConversationId).toBe('conversation-a');
    expect(state.messages).toEqual([cachedMessage]);
  });

  test('failed conversation deletion restores an in-flight message loading state', async () => {
    const deleteRequest = deferred<never>();
    const messagesRequest = deferred<{ data: Message[]; headers: Record<string, string> }>();
    const loadedMessage = message('a', 'loaded A');
    apiMock.delete.mockImplementation(() => deleteRequest.promise);
    apiMock.get.mockImplementation(() => messagesRequest.promise);
    useChatStore.setState({
      conversations: [{
        id: 'conversation-a',
        title: 'A',
        created_at: '2026-07-13T00:00:00.000Z',
        updated_at: '2026-07-13T00:00:00.000Z',
      }],
    });

    const selection = useChatStore.getState().selectConversation('conversation-a');
    await vi.waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(1));
    const deletion = useChatStore.getState().deleteConversation('conversation-a');
    deleteRequest.reject(new Error('delete failed'));
    await deletion;

    expect(useChatStore.getState().currentConversationId).toBe('conversation-a');
    expect(useChatStore.getState().loadingMessages).toBe(true);

    messagesRequest.resolve({ data: [loadedMessage], headers: {} });
    await selection;
    expect(useChatStore.getState().loadingMessages).toBe(false);
    expect(useChatStore.getState().messages).toEqual([loadedMessage]);
  });

  test('failed delete refetches instead of erasing a concurrent cache generation', async () => {
    const deleteRequest = deferred<never>();
    const olderMessage = message('m0', 'older');
    const deletedMessage = message('m1', 'delete me', 'user');
    const remainingMessage = message('m2', 'remaining');
    apiMock.delete.mockImplementation(() => deleteRequest.promise);
    apiMock.get.mockImplementation(async (_url: string, config?: { params?: { cursor?: string } }) => (
      config?.params?.cursor
        ? { data: [olderMessage], headers: {} }
        : { data: [olderMessage, deletedMessage, remainingMessage], headers: {} }
    ));

    useChatStore.setState({
      currentConversationId: 'conversation-a',
      messages: [deletedMessage, remainingMessage],
      messagesCache: { 'conversation-a': [deletedMessage, remainingMessage] },
      messagePagination: {
        'conversation-a': { hasMore: true, nextCursor: 'older-cursor', limit: 100 },
      },
    });

    const deletion = useChatStore.getState().deleteMessage('m1');
    await useChatStore.getState().loadOlderMessages('conversation-a');
    deleteRequest.reject(new Error('delete failed'));
    await deletion;

    const contents = useChatStore.getState().messagesCache['conversation-a'].map((item) => item.content);
    expect(contents).toEqual(['older', 'delete me', 'remaining']);
    expect(apiMock.get).toHaveBeenCalledTimes(2);
  });
});
