import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useAuthStore } from '../stores/useAuthStore';
import { useThemeStore } from '../stores/useThemeStore';
import { LogOut, Palette, Save, Trash2, User, Upload, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Modal from '../components/Modal';
import api from '../lib/api';
import { toast } from 'sonner';

const PRESET_COLORS = [
  '#2563eb', // Blue (Default)
  '#dc2626', // Red
  '#16a34a', // Green
  '#d97706', // Amber
  '#7c3aed', // Violet
  '#db2777', // Pink
  '#0891b2', // Cyan
];

const PRESET_BASES = [
  { name: 'Dark', color: '#111827' },
  { name: 'Light', color: '#f3f4f6' },
  { name: 'Midnight', color: '#0f172a' },
  { name: 'Forest', color: '#052e16' },
  { name: 'Coffee', color: '#271c19' },
];

export default function ProfilePage() {
  const { user, logout, updateProfile, deleteAccount } = useAuthStore();
  const { primaryColor, setPrimaryColor, baseColor, setBaseColor } = useThemeStore();
  const { t, i18n } = useTranslation();

  const [activeTab, setActiveTab] = useState<'profile' | 'theme'>('profile');

  // Profile Form State
  const [displayName, setDisplayName] = useState(user?.display_name || '');
  const [avatarUrl, setAvatarUrl] = useState(user?.avatar_url || '');
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Delete Account State
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  // Sync state when user updates
  useEffect(() => {
    if (user) {
      const serverName = user.display_name || '';
      const serverAvatar = user.avatar_url || '';

      // Only update state if it differs from server to avoid cursor jumping
      // But here we want to sync FROM server.
      // If we simply setDisplayName here, we might overwrite user's typing if user object updates in background.
      // However, for this simple profile page, we assume user object only updates on Save.

      // Debug log
      console.log('[ProfilePage] Syncing from user object:', { serverName, serverAvatar });

      setDisplayName(serverName);
      setAvatarUrl(serverAvatar);
    }
  }, [user]);

  // Check if there are changes to save
  const hasChanges = useMemo(() => {
    if (!user) return false;
    const current = displayName.trim();
    const server = (user.display_name || '').trim();
    // Debug log
    console.log('[ProfilePage] Comparing changes:', { current, server, match: current === server });
    return current !== server;
  }, [user, displayName]);

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploadingAvatar(true);
    const formData = new FormData();
    formData.append('file', file);

    const promise = api.post('/upload/avatar', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });

    toast.promise(promise, {
      loading: t('common.uploading') || 'Uploading...',
      success: (res) => {
        setAvatarUrl(res.data.url);
        // Auto-save the profile after successful upload
        updateProfile({ avatar_url: res.data.url });
        return 'Avatar updated successfully!';
      },
      error: 'Failed to upload avatar.',
    });

    try {
      await promise;
    } catch (error) {
      console.error('Avatar upload failed:', error);
    } finally {
      setIsUploadingAvatar(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);

    const promise = updateProfile({ display_name: displayName, avatar_url: avatarUrl });

    toast.promise(promise, {
      loading: t('common.saving') || 'Saving...',
      success: t('profile.saveSuccess'),
      error: t('profile.saveFail')
    });

    try {
      await promise;
    } catch (error) {
      console.error('Failed to update profile:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteAccount = async () => {
    const promise = deleteAccount();

    toast.promise(promise, {
      loading: 'Deleting account...',
      success: 'Account deleted.',
      error: t('profile.deleteFail')
    });

    try {
      await promise;
    } catch (error) {
      console.error('Failed to delete account:', error);
    }
  };

  return (
    <div className="h-full bg-bg-base text-text-main transition-colors duration-300 flex flex-col">
      {/* Header */}
      <div className="hidden md:flex bg-bg-sidebar border-b border-border p-4 items-center gap-4">
        <h1 className="text-xl font-semibold">{t('profile.title')}</h1>
      </div>

      <div className="flex-1 container mx-auto max-w-4xl p-2 md:p-6 pb-24 overflow-y-auto">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          {/* Mobile Tabs (Horizontal) */}
          <div className="md:hidden flex gap-2 overflow-x-auto pb-2 mb-2 border-b border-border">
            <button
              onClick={() => setActiveTab('profile')}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm whitespace-nowrap transition-colors ${activeTab === 'profile' ? 'bg-primary text-white' : 'text-text-muted bg-bg-sidebar'}`}
            >
              <User className="w-4 h-4" />
              {t('sidebar.profile')}
            </button>
            <button
              onClick={() => setActiveTab('theme')}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm whitespace-nowrap transition-colors ${activeTab === 'theme' ? 'bg-primary text-white' : 'text-text-muted bg-bg-sidebar'}`}
            >
              <Palette className="w-4 h-4" />
              {t('profile.theme')}
            </button>
          </div>

          {/* Desktop Sidebar Tabs (Vertical) */}
          <div className="hidden md:block md:col-span-1 space-y-1">
            <button
              onClick={() => setActiveTab('profile')}
              className={`w-full flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${activeTab === 'profile' ? 'bg-primary text-white' : 'text-text-muted hover:bg-bg-surface hover:text-text-main'}`}
            >
              <User className="w-4 h-4" />
              {t('sidebar.profile')}
            </button>
            <button
              onClick={() => setActiveTab('theme')}
              className={`w-full flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${activeTab === 'theme' ? 'bg-primary text-white' : 'text-text-muted hover:bg-bg-surface hover:text-text-main'}`}
            >
              <Palette className="w-4 h-4" />
              {t('profile.theme')}
            </button>
            <div className="pt-4 border-t border-border mt-4">
              <button
                onClick={() => logout()}
                className="w-full flex items-center gap-2 px-4 py-2 text-red-400 hover:bg-red-900/10 rounded-lg transition-colors"
              >
                <LogOut className="w-4 h-4" />
                {t('sidebar.signOut')}
              </button>
            </div>
          </div>

          {/* Content Area */}
          <div className="md:col-span-3 space-y-6">

            {/* --- PROFILE TAB --- */}
            {activeTab === 'profile' && (
              <div className="space-y-3 animate-in fade-in duration-300">
                <div className="bg-bg-sidebar rounded-xl border border-border p-3 md:p-6">
                  <h2 className="hidden md:flex text-lg font-semibold mb-6 items-center gap-2">
                    <User className="w-5 h-5 text-primary" />
                    {t('profile.publicProfile')}
                  </h2>
                  <form onSubmit={handleSaveProfile} className="space-y-4">
                    <div className="flex items-center gap-4">
                      <div className="relative group shrink-0">
                        <img
                          src={avatarUrl || user?.avatar_url}
                          alt="Avatar Preview"
                          loading="lazy"
                          className="w-16 h-16 md:w-20 md:h-20 rounded-full bg-bg-surface border-4 border-bg-base object-cover cursor-pointer hover:opacity-80 transition-opacity"
                          onError={(e) => (e.currentTarget.src = `https://ui-avatars.com/api/?name=${displayName || 'User'}`)}
                          onClick={() => fileInputRef.current?.click()}
                        />
                        <div
                          className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-full opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                          onClick={() => fileInputRef.current?.click()}
                        >
                          <Upload className="w-6 h-6 text-white" />
                        </div>
                        <input
                          type="file"
                          ref={fileInputRef}
                          onChange={handleAvatarUpload}
                          className="hidden"
                          accept="image/*"
                        />
                      </div>
                      <div className="flex-1">
                        <div className="flex flex-col justify-center h-full">
                          <h3 className="text-sm md:text-base font-medium text-text-main mb-1">{t('profile.profilePicture')}</h3>
                          <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={isUploadingAvatar}
                            className="w-fit flex items-center gap-2 px-3 py-1.5 bg-bg-surface border border-border hover:bg-bg-sidebar rounded-lg text-text-main transition-colors text-xs"
                          >
                            {isUploadingAvatar ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                            {isUploadingAvatar ? t('common.uploading') : t('profile.uploadNewPicture')}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs font-medium text-text-muted mb-1">{t('profile.displayName')}</label>
                        <input
                          type="text"
                          value={displayName}
                          onChange={(e) => setDisplayName(e.target.value)}
                          className="w-full bg-bg-base border border-border rounded-lg px-3 py-2 text-sm text-text-main focus:ring-2 focus:ring-primary outline-none transition-all"
                          placeholder="Your Name"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-text-muted mb-1">{t('profile.username')}</label>
                        <input
                          type="text"
                          value={user?.username}
                          disabled
                          className="w-full bg-bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text-muted cursor-not-allowed"
                        />
                      </div>
                    </div>

                    <div className="pt-2 flex justify-end">
                      <button
                        type="submit"
                        disabled={isSaving || !hasChanges}
                        className="flex items-center gap-2 px-3 py-1.5 md:px-4 md:py-2 bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-gray-500 text-sm"
                      >
                        <Save className="w-4 h-4" />
                        {isSaving ? t('common.saving') : t('profile.saveChanges')}
                      </button>
                    </div>
                  </form>
                </div>

                {/* Danger Zone */}
                <div className="bg-red-900/10 rounded-xl border border-red-900/20 p-3 md:p-6 mt-10 md:mt-0">
                  <h2 className="text-sm md:text-lg font-semibold text-red-500 mb-1 md:mb-2 flex items-center gap-2">
                    <Trash2 className="w-4 h-4 md:w-5 md:h-5" />
                    {t('profile.dangerZone')}
                  </h2>
                  <p className="text-xs md:text-sm text-red-400 mb-2 md:mb-4">
                    {t('profile.deleteWarning')}
                  </p>
                  <button
                    onClick={() => setIsDeleteModalOpen(true)}
                    className="px-3 py-1.5 md:px-4 md:py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors text-xs md:text-sm font-medium"
                  >
                    {t('profile.deleteAccount')}
                  </button>
                </div>
              </div>
            )}

            {/* --- THEME TAB --- */}
            {activeTab === 'theme' && (
              <div className="space-y-4 md:space-y-6 animate-in fade-in duration-300">
                <div className="bg-bg-sidebar rounded-xl border border-border p-4 md:p-6 space-y-4 md:space-y-6">
                  <h2 className="hidden md:flex text-lg font-semibold mb-4 items-center gap-2">
                    <Palette className="w-5 h-5 text-primary" />
                    {t('profile.appearance')}
                  </h2>

                  {/* Language Switcher */}
                  <div>
                    <label className="block text-sm font-medium text-text-muted mb-2 md:mb-3">{t('profile.language')}</label>
                    <div className="flex gap-2 md:gap-3">
                      <button
                        onClick={() => i18n.changeLanguage('en')}
                        className={`flex-1 md:flex-none px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${i18n.language.startsWith('en')
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border bg-bg-base text-text-muted hover:border-text-muted'
                          }`}
                      >
                        English
                      </button>
                      <button
                        onClick={() => i18n.changeLanguage('zh')}
                        className={`flex-1 md:flex-none px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${i18n.language.startsWith('zh')
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border bg-bg-base text-text-muted hover:border-text-muted'
                          }`}
                      >
                        中文
                      </button>
                    </div>
                  </div>

                  {/* Primary Color */}
                  <div>
                    <label className="block text-sm font-medium text-text-muted mb-2 md:mb-3">{t('profile.accentColor')}</label>
                    <div className="flex flex-wrap gap-2 md:gap-3">
                      {PRESET_COLORS.map((color) => (
                        <button
                          key={color}
                          onClick={() => setPrimaryColor(color)}
                          className={`w-8 h-8 md:w-8 md:h-8 rounded-full border-2 transition-transform hover:scale-110 ${primaryColor === color ? 'border-white scale-110 ring-2 ring-primary/50' : 'border-transparent'
                            }`}
                          style={{ backgroundColor: color }}
                          title={color}
                        />
                      ))}
                      <div className="relative group">
                        <input
                          type="color"
                          value={primaryColor}
                          onChange={(e) => setPrimaryColor(e.target.value)}
                          className="w-8 h-8 rounded-full overflow-hidden cursor-pointer border-0 p-0 absolute opacity-0"
                        />
                        <div
                          className="w-8 h-8 rounded-full border-2 border-border flex items-center justify-center bg-linear-to-br from-red-500 via-green-500 to-blue-500"
                          title="Custom Color"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Background Theme */}
                  <div>
                    <label className="block text-sm font-medium text-text-muted mb-2 md:mb-3">{t('profile.backgroundTheme')}</label>
                    <div className="grid grid-cols-3 sm:grid-cols-3 md:grid-cols-4 gap-3 md:gap-3">
                      {PRESET_BASES.map((base) => (
                        <button
                          key={base.name}
                          onClick={() => setBaseColor(base.color)}
                          className={`px-3 py-3 md:px-3 md:py-3 rounded-xl md:rounded-xl text-sm md:text-sm font-medium border-2 transition-all flex flex-col items-center gap-2 md:gap-2 ${baseColor === base.color
                            ? 'border-primary bg-bg-surface text-text-main shadow-md'
                            : 'border-border bg-bg-base text-text-muted hover:border-text-muted hover:bg-bg-surface/50'
                            }`}
                        >
                          <div className="w-6 h-6 md:w-6 md:h-6 rounded-full border border-border shadow-sm" style={{ backgroundColor: base.color }}></div>
                          {base.name}
                        </button>
                      ))}
                    </div>

                    <div className="mt-3 md:mt-4 pt-3 md:pt-4 border-t border-border flex items-center gap-3">
                      <label className="text-xs md:text-sm text-text-muted">{t('profile.customHex')}:</label>
                      <div className="flex items-center gap-2 bg-bg-base px-2 py-1 rounded border border-border w-fit">
                        <input
                          type="color"
                          value={baseColor}
                          onChange={(e) => setBaseColor(e.target.value)}
                          className="w-5 h-5 md:w-6 md:h-6 rounded cursor-pointer border-0 p-0 bg-transparent"
                        />
                        <span className="text-xs md:text-sm font-mono text-text-muted uppercase">{baseColor}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

          </div>
        </div>
      </div>

      {/* Delete Account Modal */}
      <Modal
        isOpen={isDeleteModalOpen}
        onClose={() => setIsDeleteModalOpen(false)}
        title={t('profile.deleteTitle')}
        footer={
          <>
            <button
              onClick={() => setIsDeleteModalOpen(false)}
              className="px-4 py-2 text-sm text-text-muted hover:text-text-main hover:bg-bg-surface border border-border rounded-lg transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleDeleteAccount}
              disabled={deleteConfirmText !== 'DELETE'}
              className="px-4 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('common.delete')}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="bg-red-500/10 border border-red-500/20 text-red-500 p-4 rounded-lg text-sm">
            {t('profile.deleteAccountWarning')}
          </div>
          <div>
            <label className="block text-sm text-text-muted mb-2">
              {t('profile.typeToDelete')} <span className="font-mono font-bold text-text-main">DELETE</span>
            </label>
            <input
              type="text"
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              className="w-full bg-bg-base border border-border rounded-lg px-3 py-2 text-text-main focus:ring-2 focus:ring-red-500 outline-none"
              placeholder="DELETE"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}