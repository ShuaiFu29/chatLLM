import { useChatStore } from './useChatStore';
import { useKnowledgeFilesStore } from './useKnowledgeFilesStore';
import { useProjectSpaceStore } from './useProjectSpaceStore';
import { useSearchStore } from './useSearchStore';
import { useAgentStore } from './useAgentStore';

export const resetUserScopedStores = () => {
  useKnowledgeFilesStore.getState().reset();
  useChatStore.getState().reset();
  useSearchStore.getState().reset();
  useProjectSpaceStore.getState().reset();
  useAgentStore.getState().reset();
};
