import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Upload, FileText, Trash2, Loader2, Database, CheckCircle, AlertCircle, RefreshCw, X, BookOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { toSafeError } from '../lib/safeError';
import {
  DOCUMENT_UPLOAD_ACCEPT,
  DOCUMENT_UPLOAD_LIMIT_SUMMARY,
  formatDocumentSizeLimit,
  formatDocumentTypeName,
  uploadFile,
  validateDocumentUpload,
  type UploadProgress,
} from '../lib/uploadManager';
import Modal from '../components/Modal';
import DocumentViewerModal, { type DocumentReference } from '../components/DocumentViewerModal';
import Skeleton from '../components/Skeleton';
import { useProjectSpaceStore } from '../stores/useProjectSpaceStore';
import {
  useKnowledgeFilesStore,
  type KnowledgeFile,
} from '../stores/useKnowledgeFilesStore';

interface UploadingFile {
  name: string;
  progress: number;
  status: string;
  message?: string;
}

export default function KnowledgeBase() {
  const { t } = useTranslation();
  const { currentProjectSpaceId, projectSpaces } = useProjectSpaceStore();
  const files = useKnowledgeFilesStore((state) => state.files);
  const isLoading = useKnowledgeFilesStore((state) => state.loading);
  const refreshKnowledgeFiles = useKnowledgeFilesStore((state) => state.refreshFiles);
  const startKnowledgePolling = useKnowledgeFilesStore((state) => state.startPolling);
  const stopKnowledgePolling = useKnowledgeFilesStore((state) => state.stopPolling);
  const cancelKnowledgeFilesFetch = useKnowledgeFilesStore((state) => state.cancelFetch);
  const removeKnowledgeFile = useKnowledgeFilesStore((state) => state.removeFile);
  const upsertKnowledgeFile = useKnowledgeFilesStore((state) => state.upsertFile);
  const [uploadState, setUploadState] = useState<UploadingFile | null>(null);
  const [deleteFileTarget, setDeleteFileTarget] = useState<{ id: string; filename: string } | null>(null);
  const [selectedDocument, setSelectedDocument] = useState<DocumentReference | null>(null);
  const [notification, setNotification] = useState<{ type: 'success' | 'error', message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadClearTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearUploadClearTimeout = useCallback(() => {
    if (uploadClearTimeout.current) {
      clearTimeout(uploadClearTimeout.current);
      uploadClearTimeout.current = null;
    }
  }, []);

  const refreshFiles = useCallback(() => {
    void refreshKnowledgeFiles(currentProjectSpaceId);
  }, [currentProjectSpaceId, refreshKnowledgeFiles]);

  const currentProjectSpace = projectSpaces.find((space) => space.id === currentProjectSpaceId);

  useEffect(() => {
    startKnowledgePolling(currentProjectSpaceId);
    return () => {
      stopKnowledgePolling(currentProjectSpaceId);
      clearUploadClearTimeout();
    };
  }, [
    clearUploadClearTimeout,
    currentProjectSpaceId,
    startKnowledgePolling,
    stopKnowledgePolling,
  ]);

  const handleDeleteClick = (id: string, filename: string) => {
    setDeleteFileTarget({ id, filename });
  };

  const showNotification = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 5000);
  };

  const confirmDeleteFile = async () => {
    if (!deleteFileTarget) return;

    const { id } = deleteFileTarget;

    cancelKnowledgeFilesFetch(currentProjectSpaceId);
    // Optimistic Update: Immediately remove from UI and close modal
    removeKnowledgeFile(id);
    setDeleteFileTarget(null);
    showNotification('success', t('knowledge.deleteSuccess'));

    try {
      await api.delete(`/upload/files/${id}`);
      removeKnowledgeFile(id);
    } catch (error) {
      console.error('Delete failed:', toSafeError(error));
      // Revert UI on failure
      refreshFiles();
      showNotification('error', t('knowledge.deleteFail'));
    }
  };

  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 0) {
      await processFiles(files);
    }
  };

  const processFile = async (file: File) => {
    const validation = validateDocumentUpload(file);
    if (!validation.ok) {
      if (validation.code === 'too-large') {
        showNotification('error', t('knowledge.fileTooLarge', {
          filename: file.name,
          fileType: formatDocumentTypeName(validation.documentType),
          maxSize: formatDocumentSizeLimit(validation.maxBytes),
        }));
      } else {
        showNotification('error', t('knowledge.unsupportedFileType'));
      }
      return;
    }

    clearUploadClearTimeout();

    setUploadState({
      name: file.name,
      progress: 0,
      status: 'starting'
    });

    try {
      await uploadFile(file, (progress: UploadProgress) => {
        setUploadState({
          name: file.name,
          progress: progress.progress,
          status: progress.status,
          message: progress.message
        });

        if (progress.status === 'processing' || progress.status === 'completed') {
          refreshFiles();
        }
      }, { projectSpaceId: currentProjectSpaceId });

      setUploadState(null);
      refreshFiles();
      showNotification('success', t('knowledge.uploadComplete'));

    } catch (error) {
      console.error('Upload failed:', toSafeError(error));
      setUploadState(prev => prev ? { ...prev, status: 'error', message: t('knowledge.uploadFail') } : null);
      uploadClearTimeout.current = setTimeout(() => {
        setUploadState(prev => (
          prev?.name === file.name && prev.status === 'error' ? null : prev
        ));
        uploadClearTimeout.current = null;
      }, 5000);
      showNotification('error', t('knowledge.uploadFail'));
    }
  };

  const processFiles = async (files: File[]) => {
    for (const file of files) {
      await processFile(file);
    }
  };

  const handleRetryFile = async (id: string) => {
    try {
      const { data } = await api.post<KnowledgeFile>(`/upload/files/${id}/retry`);
      cancelKnowledgeFilesFetch(currentProjectSpaceId);
      upsertKnowledgeFile(data);
      showNotification('success', t('knowledge.retryQueued'));
      startKnowledgePolling(currentProjectSpaceId);
    } catch (error) {
      console.error('Retry failed:', toSafeError(error));
      showNotification('error', t('knowledge.retryFailed'));
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    if (fileInputRef.current) fileInputRef.current.value = '';
    await processFiles(files);
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed': return <CheckCircle className="w-5 h-5 text-green-500" />;
      case 'processing': return <RefreshCw className="w-5 h-5 text-blue-500 animate-spin" />;
      case 'pending': return <Loader2 className="w-5 h-5 text-gray-400 animate-spin" />;
      case 'failed': return <AlertCircle className="w-5 h-5 text-red-500" />;
      default: return <Loader2 className="w-5 h-5 text-gray-400" />;
    }
  };

  const getUploadStatusLabel = (status: string) => {
    switch (status) {
      case 'hashing': return t('knowledge.uploadStatusHashing');
      case 'uploading': return t('knowledge.uploadStatusUploading');
      case 'merging': return t('knowledge.uploadStatusMerging');
      case 'processing': return t('knowledge.uploadStatusProcessing');
      case 'completed': return t('knowledge.uploadStatusCompleted');
      case 'error': return t('knowledge.uploadStatusError');
      default: return t('knowledge.uploadStatusStarting');
    }
  };

  const canViewFile = (file: KnowledgeFile) => file.status === 'completed';

  return (
    <div className="h-full bg-bg-base text-text-main transition-colors duration-300 flex flex-col">
      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={!!deleteFileTarget}
        onClose={() => setDeleteFileTarget(null)}
        title={t('knowledge.deleteTitle')}
        footer={
          <>
            <button
              onClick={() => setDeleteFileTarget(null)}
              className="px-4 py-2 text-sm text-text-muted hover:text-text-main hover:bg-bg-surface border border-border rounded-lg transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={confirmDeleteFile}
              className="px-4 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
            >
              {t('common.delete')}
            </button>
          </>
        }
      >
        <p className="text-text-muted">
          {t('knowledge.deleteConfirm')} <span className="font-semibold text-text-main">"{deleteFileTarget?.filename}"</span>?
          <br />
          {t('knowledge.deleteWarning')}
        </p>
      </Modal>

      <DocumentViewerModal
        document={selectedDocument}
        onClose={() => setSelectedDocument(null)}
      />

      {/* Header */}
      <div className="hidden md:flex bg-bg-sidebar border-b border-border p-4 items-center gap-4">
        <div className="flex items-center gap-2">
          <Database className="w-5 h-5 text-primary" />
          <h1 className="text-xl font-semibold">{t('knowledge.title')}</h1>
          {currentProjectSpace && (
            <span className="text-sm text-text-muted border border-border rounded-lg px-2 py-1">
              {currentProjectSpace.name}
            </span>
          )}
        </div>
      </div>

      {/* Inline Notification Banner */}
      {notification && (
        <div className={`
          px-4 py-3 text-sm font-medium flex items-center justify-between
          ${notification.type === 'success' ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}
        `}>
          <div className="flex items-center gap-2">
            {notification.type === 'success' ? <CheckCircle className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
            {notification.message}
          </div>
          <button onClick={() => setNotification(null)} className="hover:opacity-70">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div
        className={`flex-1 container mx-auto max-w-4xl p-4 md:p-6 pb-24 overflow-y-auto transition-colors ${isDragging ? 'bg-primary/5 border-2 border-dashed border-primary rounded-xl m-4' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag Overlay */}
        {isDragging && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-bg-base/80 backdrop-blur-sm rounded-xl pointer-events-none">
            <div className="flex flex-col items-center gap-4 text-primary animate-bounce">
              <Upload className="w-16 h-16" />
              <h3 className="text-2xl font-bold">{t('knowledge.dropToUpload')}</h3>
            </div>
          </div>
        )}

        {/* Actions Bar */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
          <div>
            <h2 className="text-lg font-medium">{t('knowledge.uploadedDocuments')}</h2>
            <p className="text-sm text-text-muted">{t('knowledge.description')}</p>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-text-muted">
              {t('knowledge.supportedTypesHint', { limits: DOCUMENT_UPLOAD_LIMIT_SUMMARY })}
            </p>
          </div>
          <div className="flex gap-2 w-full md:w-auto">
            <input
              type="file"
              multiple
              ref={fileInputRef}
              onChange={handleFileUpload}
              className="hidden"
              accept={DOCUMENT_UPLOAD_ACCEPT}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={!!uploadState}
              className="w-full md:w-auto flex justify-center items-center gap-2 px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors disabled:opacity-50 shadow-sm hover:shadow-md"
            >
              {uploadState ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              {t('knowledge.uploadNewFile')}
            </button>
          </div>
        </div>

        {/* Upload Progress */}
        {uploadState && (
          <div className="mb-6 p-4 bg-bg-surface border border-border rounded-xl">
            <div className="flex justify-between items-center mb-2">
              <span className="font-medium">{uploadState.name}</span>
              <span className="text-sm text-text-muted">{getUploadStatusLabel(uploadState.status)} {uploadState.progress}%</span>
            </div>
            <div className="w-full bg-bg-base rounded-full h-2.5 overflow-hidden">
              <div
                className="bg-primary h-2.5 rounded-full transition-all duration-300"
                style={{ width: `${uploadState.progress}%` }}
              ></div>
            </div>
            {uploadState.message && <p className="text-xs text-text-muted mt-2">{uploadState.message}</p>}
          </div>
        )}

        {/* Files List - Desktop Table */}
        <div className="hidden md:block bg-bg-sidebar rounded-xl border border-border overflow-hidden">
          {isLoading ? (
            <div className="p-6 space-y-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-4 p-2">
                  <Skeleton className="w-10 h-10 rounded-lg shrink-0" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-3 w-1/4" />
                  </div>
                  <Skeleton className="h-8 w-8 rounded-lg shrink-0" />
                </div>
              ))}
            </div>
          ) : files.length === 0 ? (
            <div className="p-12 text-center text-text-muted flex flex-col items-center gap-3">
              <FileText className="w-12 h-12 opacity-20" />
              <p>{t('knowledge.noDocuments')}</p>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="text-primary hover:underline text-sm"
              >
                {t('knowledge.uploadFirst')}
              </button>
            </div>
          ) : (
            <table className="w-full table-fixed text-left border-collapse">
              <colgroup>
                <col />
                <col className="w-[160px]" />
                <col className="w-[180px]" />
                <col className="w-[128px]" />
              </colgroup>
              <thead className="bg-bg-surface text-xs uppercase text-text-muted font-semibold">
                <tr>
                  <th className="px-6 py-4">{t('knowledge.fileName')}</th>
                  <th className="px-6 py-4">{t('knowledge.status')}</th>
                  <th className="px-6 py-4">{t('knowledge.uploadedAt')}</th>
                  <th className="px-6 py-4 text-right">{t('knowledge.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {files.map((file) => (
                  <tr key={file.id} className="hover:bg-bg-surface/50 transition-colors">
                    <td className="px-6 py-4 align-middle">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="shrink-0 p-2 bg-primary/10 rounded-lg text-primary">
                          <FileText className="w-5 h-5" />
                        </div>
                        <div className="min-w-0">
                          <span className="font-medium text-text-main block break-words leading-snug">{file.filename.trim()}</span>
                          {file.error_message && <span className="text-xs text-red-400 block mt-1 break-words leading-relaxed">{file.error_message}</span>}
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 align-middle">
                      <div className="flex items-center gap-2">
                        {getStatusIcon(file.status)}
                        <span className="text-sm capitalize whitespace-nowrap">
                          {file.status}
                          {file.status === 'processing' && ` (${file.progress}%)`}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-text-muted text-sm whitespace-nowrap align-middle">
                      {new Date(file.created_at).toLocaleString()}
                    </td>
                    <td className="px-6 py-4 text-right align-middle">
                      <div className="flex justify-end gap-1">
                        <button
                          onClick={() => setSelectedDocument({
                            id: file.id,
                            filename: file.filename,
                            document_kind: file.document_kind,
                          })}
                          disabled={!canViewFile(file)}
                          className="p-2 text-text-muted hover:text-primary hover:bg-primary/10 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-muted"
                          title={canViewFile(file) ? t('knowledge.viewFileAction') : t('knowledge.fileNotReadyAction')}
                          aria-label={canViewFile(file) ? t('knowledge.viewFileAction') : t('knowledge.fileNotReadyAction')}
                        >
                          <BookOpen className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDeleteClick(file.id, file.filename)}
                          className="p-2 text-text-muted hover:text-red-400 hover:bg-red-900/10 rounded-lg transition-colors"
                          title={t('knowledge.deleteFileAction')}
                          aria-label={t('knowledge.deleteFileAction')}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                        {file.status === 'failed' && (
                          <button
                            onClick={() => handleRetryFile(file.id)}
                            className="p-2 text-text-muted hover:text-primary hover:bg-primary/10 rounded-lg transition-colors"
                            title={t('knowledge.retryProcessingAction')}
                            aria-label={t('knowledge.retryProcessingAction')}
                          >
                            <RefreshCw className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Files List - Mobile Cards */}
        <div className="md:hidden space-y-4">
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="bg-bg-sidebar p-4 rounded-xl border border-border shadow-sm flex flex-col gap-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3 w-full">
                      <Skeleton className="w-10 h-10 rounded-lg shrink-0" />
                      <div className="space-y-2 flex-1">
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-3 w-1/2" />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : files.length === 0 ? (
            <div className="p-8 text-center text-text-muted flex flex-col items-center gap-3 bg-bg-sidebar rounded-xl border border-border">
              <FileText className="w-10 h-10 opacity-20" />
              <p>{t('knowledge.noDocuments')}</p>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="text-primary hover:underline text-sm"
              >
                {t('knowledge.uploadFirst')}
              </button>
            </div>
          ) : (
            files.map((file) => (
              <div key={file.id} className="bg-bg-sidebar p-4 rounded-xl border border-border shadow-sm flex flex-col gap-3">
                <div className="flex justify-between items-start gap-2">
                  <div className="flex min-w-0 items-center gap-3 overflow-hidden">
                    <div className="p-2 bg-primary/10 rounded-lg text-primary shrink-0">
                      <FileText className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <span className="font-medium text-text-main block truncate">{file.filename.trim()}</span>
                      <span className="text-xs text-text-muted">{new Date(file.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      onClick={() => setSelectedDocument({
                        id: file.id,
                        filename: file.filename,
                        document_kind: file.document_kind,
                      })}
                      disabled={!canViewFile(file)}
                      className="p-2 text-text-muted hover:text-primary active:bg-primary/10 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-text-muted disabled:active:bg-transparent"
                      title={canViewFile(file) ? t('knowledge.viewFileAction') : t('knowledge.fileNotReadyAction')}
                      aria-label={canViewFile(file) ? t('knowledge.viewFileAction') : t('knowledge.fileNotReadyAction')}
                    >
                      <BookOpen className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDeleteClick(file.id, file.filename)}
                      className="p-2 -mr-1 text-text-muted hover:text-red-400 active:bg-red-900/10 rounded-lg transition-colors"
                      title={t('knowledge.deleteFileAction')}
                      aria-label={t('knowledge.deleteFileAction')}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                    {file.status === 'failed' && (
                      <button
                        onClick={() => handleRetryFile(file.id)}
                        className="p-2 text-text-muted hover:text-primary active:bg-primary/10 rounded-lg transition-colors"
                        title={t('knowledge.retryProcessingAction')}
                        aria-label={t('knowledge.retryProcessingAction')}
                      >
                        <RefreshCw className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-border">
                  <div className="flex items-center gap-2">
                    {getStatusIcon(file.status)}
                    <span className="text-sm capitalize text-text-muted">
                      {file.status}
                      {file.status === 'processing' && ` (${file.progress}%)`}
                    </span>
                  </div>
                  {file.error_message && <span className="text-xs text-red-400 truncate max-w-[150px]">{file.error_message}</span>}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
