import type { ReactNode } from 'react';

function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return <svg aria-hidden="true" focusable="false" className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">{children}</svg>;
}

type Props = { size?: number };
export const PlusIcon = (p: Props) => <Icon {...p}><path d="M12 5v14M5 12h14" /></Icon>;
export const ChatIcon = (p: Props) => <Icon {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></Icon>;
export const PaperclipIcon = (p: Props) => <Icon {...p}><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></Icon>;
export const SendIcon = (p: Props) => <Icon {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Icon>;
export const FileIcon = (p: Props) => <Icon {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h5" /></Icon>;
export const LibraryIcon = (p: Props) => <Icon {...p}><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" /></Icon>;
export const LogOutIcon = (p: Props) => <Icon {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></Icon>;
export const ChevronIcon = (p: Props) => <Icon {...p}><path d="m6 9 6 6 6-6" /></Icon>;
export const MenuIcon = (p: Props) => <Icon {...p}><path d="M4 6h16M4 12h16M4 18h16" /></Icon>;
export const CloseIcon = (p: Props) => <Icon {...p}><path d="M18 6 6 18M6 6l12 12" /></Icon>;
export const BackIcon = (p: Props) => <Icon {...p}><path d="M19 12H5M11 18l-6-6 6-6" /></Icon>;
export const SparkIcon = (p: Props) => <Icon {...p}><path d="M10 3.5 11.6 8a2 2 0 0 0 1.2 1.2l4.5 1.6-4.5 1.6a2 2 0 0 0-1.2 1.2L10 18.1l-1.6-4.5a2 2 0 0 0-1.2-1.2l-4.5-1.6 4.5-1.6A2 2 0 0 0 8.4 8zM18 3v4M16 5h4M18 17v4M16 19h4" /></Icon>;
export const ShieldIcon = (p: Props) => <Icon {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></Icon>;
export const ScaleIcon = (p: Props) => <Icon {...p}><path d="M12 3v18M7 21h10M5 7h14M5 7l-3 7a4 4 0 0 0 6 0zM19 7l-3 7a4 4 0 0 0 6 0z" /></Icon>;
export const ArrowDownIcon = (p: Props) => <Icon {...p}><path d="M12 5v14M19 12l-7 7-7-7" /></Icon>;
export const StopIcon = (p: Props) => <Icon {...p}><rect x="6" y="6" width="12" height="12" rx="2" /></Icon>;
export const CopyIcon = (p: Props) => <Icon {...p}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></Icon>;
export const MailIcon = (p: Props) => <Icon {...p}><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 6L2 7" /></Icon>;
export const RefreshIcon = (p: Props) => <Icon {...p}><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" /></Icon>;
export const ExternalIcon = (p: Props) => <Icon {...p}><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></Icon>;
