export const getAvatarUrl = (
  avatarUrl?: string | null,
  displayName?: string | null,
  size = 64,
) => {
  const trimmedUrl = avatarUrl?.trim();
  if (!trimmedUrl) {
    const name = encodeURIComponent(displayName?.trim() || 'User');
    return `https://ui-avatars.com/api/?name=${name}&size=${size}`;
  }

  if (trimmedUrl.startsWith('/api/')) return trimmedUrl;

  const separator = trimmedUrl.includes('?') ? '&' : '?';
  return `${trimmedUrl}${separator}s=${size}`;
};
