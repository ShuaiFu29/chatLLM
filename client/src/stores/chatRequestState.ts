export interface MessageFetchTicket {
  conversationId: string;
  generation: number;
  cacheGeneration: number;
  controller: AbortController;
}

export interface OlderMessagesTicket {
  conversationId: string;
  controller: AbortController;
}

export class ChatRequestState {
  private fetchGenerations = new Map<string, number>();
  private cacheGenerations = new Map<string, number>();
  private messageFetches = new Map<string, MessageFetchTicket>();
  private olderMessageFetches = new Map<string, OlderMessagesTicket>();
  private streamControllers = new Map<string, AbortController>();
  private stoppedConversations = new Set<string>();

  beginMessageFetch(conversationId: string): MessageFetchTicket {
    this.messageFetches.get(conversationId)?.controller.abort();
    const generation = (this.fetchGenerations.get(conversationId) || 0) + 1;
    this.fetchGenerations.set(conversationId, generation);
    const ticket = {
      conversationId,
      generation,
      cacheGeneration: this.getCacheGeneration(conversationId),
      controller: new AbortController(),
    };
    this.messageFetches.set(conversationId, ticket);
    return ticket;
  }

  isCurrentMessageFetch(ticket: MessageFetchTicket) {
    return this.messageFetches.get(ticket.conversationId) === ticket
      && this.fetchGenerations.get(ticket.conversationId) === ticket.generation;
  }

  finishMessageFetch(ticket: MessageFetchTicket) {
    if (this.messageFetches.get(ticket.conversationId) === ticket) {
      this.messageFetches.delete(ticket.conversationId);
    }
  }

  isLoadingMessages(conversationId: string) {
    return this.messageFetches.has(conversationId);
  }

  beginOlderMessagesFetch(conversationId: string): OlderMessagesTicket | null {
    if (this.olderMessageFetches.has(conversationId)) return null;
    const ticket = { conversationId, controller: new AbortController() };
    this.olderMessageFetches.set(conversationId, ticket);
    return ticket;
  }

  isCurrentOlderMessagesFetch(ticket: OlderMessagesTicket) {
    return this.olderMessageFetches.get(ticket.conversationId) === ticket;
  }

  finishOlderMessagesFetch(ticket: OlderMessagesTicket) {
    if (this.olderMessageFetches.get(ticket.conversationId) === ticket) {
      this.olderMessageFetches.delete(ticket.conversationId);
    }
  }

  isLoadingOlderMessages(conversationId: string) {
    return this.olderMessageFetches.has(conversationId);
  }

  getCacheGeneration(conversationId: string) {
    return this.cacheGenerations.get(conversationId) || 0;
  }

  bumpCacheGeneration(conversationId: string) {
    const generation = this.getCacheGeneration(conversationId) + 1;
    this.cacheGenerations.set(conversationId, generation);
    return generation;
  }

  beginStream(conversationId: string) {
    this.streamControllers.get(conversationId)?.abort();
    const controller = new AbortController();
    this.streamControllers.set(conversationId, controller);
    this.stoppedConversations.delete(conversationId);
    return controller;
  }

  finishStream(conversationId: string, controller: AbortController) {
    if (this.streamControllers.get(conversationId) !== controller) return false;
    this.streamControllers.delete(conversationId);
    if (!controller.signal.aborted) this.stoppedConversations.delete(conversationId);
    return true;
  }

  stopStream(conversationId: string) {
    const controller = this.streamControllers.get(conversationId);
    if (!controller || controller.signal.aborted) return false;
    this.stoppedConversations.add(conversationId);
    controller.abort();
    return true;
  }

  getStreamController(conversationId: string) {
    const controller = this.streamControllers.get(conversationId) || null;
    return controller?.signal.aborted ? null : controller;
  }

  hasActiveStream(conversationId: string) {
    return this.getStreamController(conversationId) !== null;
  }

  isCurrentStream(conversationId: string, controller: AbortController) {
    return this.streamControllers.get(conversationId) === controller
      && !controller.signal.aborted;
  }

  isStopped(conversationId: string) {
    return this.stoppedConversations.has(conversationId);
  }

  clearConversation(conversationId: string) {
    this.messageFetches.get(conversationId)?.controller.abort();
    this.olderMessageFetches.get(conversationId)?.controller.abort();
    this.streamControllers.get(conversationId)?.abort();
    this.messageFetches.delete(conversationId);
    this.olderMessageFetches.delete(conversationId);
    this.streamControllers.delete(conversationId);
    this.fetchGenerations.delete(conversationId);
    this.cacheGenerations.delete(conversationId);
    this.stoppedConversations.delete(conversationId);
  }

  reset() {
    for (const ticket of this.messageFetches.values()) ticket.controller.abort();
    for (const ticket of this.olderMessageFetches.values()) ticket.controller.abort();
    for (const controller of this.streamControllers.values()) controller.abort();
    this.fetchGenerations.clear();
    this.cacheGenerations.clear();
    this.messageFetches.clear();
    this.olderMessageFetches.clear();
    this.streamControllers.clear();
    this.stoppedConversations.clear();
  }
}

export const chatRequestState = new ChatRequestState();
