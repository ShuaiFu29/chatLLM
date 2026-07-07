export const getAvatarUrl = (
  avatarUrl?: string | null,
  displayName?: string | null,
  size = 64,
) => {
  const trimmedUrl = avatarUrl?.trim();
  if (!trimmedUrl) {
    const initials = (displayName?.trim() || 'User')
      .split(/\s+/)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || 'U';
    const safeSize = Math.max(24, Math.min(size, 256));
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${safeSize}" height="${safeSize}" viewBox="0 0 ${safeSize} ${safeSize}">
        <rect width="100%" height="100%" rx="${Math.round(safeSize * 0.28)}" fill="#2563eb"/>
        <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" fill="#ffffff" font-family="Arial, sans-serif" font-size="${Math.round(safeSize * 0.38)}" font-weight="700">${initials}</text>
      </svg>
    `.trim();
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  if (trimmedUrl.startsWith('/api/')) return trimmedUrl;

  const separator = trimmedUrl.includes('?') ? '&' : '?';
  return `${trimmedUrl}${separator}s=${size}`;
};
