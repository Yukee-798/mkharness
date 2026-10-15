import { ChevronDown, Languages, Settings2, KeyRound, Sun, Moon, Monitor } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { ModelSettingsForm } from './ModelSettings';
import { McpConnections } from './McpConnections';
import { Skills } from './Skills';
import { useLocale, type Locale } from './locale';
import { useTheme } from './theme';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { ScrollArea } from './ui/scroll-area';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from './ui/dropdown-menu';

const desktopQuery = '(min-width: 768px)';
function subscribeLayout(onChange: () => void) {
  if (typeof matchMedia !== 'function') return () => {};
  const media = matchMedia(desktopQuery);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
function isDesktop() {
  return typeof matchMedia === 'function' && matchMedia(desktopQuery).matches;
}
function serverLayout() {
  return false;
}

export function SettingsDialog({
  userId,
  open,
  onOpenChange,
  initialProvider,
  initialSection = 'general',
  customMcp = false,
  skills = false,
}: {
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialProvider?: string;
  customMcp?: boolean;
  skills?: boolean;
  initialSection?: 'general' | 'models' | 'connections' | 'skills';
}) {
  const { t } = useLocale();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(42rem,calc(100dvh_-_2rem))] w-[calc(100vw_-_2rem)] max-w-5xl flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-5xl md:h-[min(42rem,calc(100dvh_-_4rem))]">
        <DialogHeader className="shrink-0 px-6 py-6 text-left md:px-8">
          <DialogTitle>{t('设置')}</DialogTitle>
          <DialogDescription className="sr-only">
            {t('管理此浏览器的偏好与模型配置。')}
          </DialogDescription>
        </DialogHeader>
        {open && (
          <SettingsSections
            userId={userId}
            mcpAvailable={customMcp}
            skillsAvailable={skills}
            initialProvider={initialProvider}
            initialSection={initialSection}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
function SettingsSections({
  userId,
  initialProvider,
  initialSection,
  mcpAvailable,
  skillsAvailable,
}: {
  userId: string;
  mcpAvailable: boolean;
  skillsAvailable: boolean;
  initialProvider?: string;
  initialSection: 'general' | 'models' | 'connections' | 'skills';
}) {
  const { t } = useLocale();
  const [section, setSection] = useState(initialSection);
  const [modelsVisited, setModelsVisited] = useState(initialSection === 'models');
  const desktop = useSyncExternalStore(subscribeLayout, isDesktop, serverLayout);
  return (
    <Tabs
      value={
        (section === 'connections' && !mcpAvailable) || (section === 'skills' && !skillsAvailable)
          ? 'general'
          : section
      }
      orientation={desktop ? 'vertical' : 'horizontal'}
      className="min-h-0 flex-1 gap-0 md:flex-row"
      onValueChange={(value) => {
        setSection(value as typeof section);
        if (value === 'models') setModelsVisited(true);
      }}
    >
      <TabsList
        aria-label={t('设置')}
        className="h-auto w-full shrink-0 justify-start gap-1 rounded-none border-b bg-transparent px-3 pb-3 text-foreground md:w-56 md:flex-col md:items-stretch md:justify-start md:gap-2 md:border-b-0 md:px-4 md:pb-6"
      >
        <TabsTrigger
          value="general"
          className="justify-start rounded-lg px-4 py-3 data-[state=active]:bg-muted data-[state=active]:shadow-none"
        >
          <Settings2 className="mr-3 size-4 shrink-0" />
          {t('通用')}
        </TabsTrigger>
        <TabsTrigger
          value="models"
          className="justify-start rounded-lg px-4 py-3 data-[state=active]:bg-muted data-[state=active]:shadow-none"
        >
          <KeyRound className="mr-3 size-4 shrink-0" />
          {t('模型与 API Key')}
        </TabsTrigger>
        {mcpAvailable && (
          <TabsTrigger
            value="connections"
            className="justify-start rounded-lg px-4 py-3 data-[state=active]:bg-muted data-[state=active]:shadow-none"
          >
            <Settings2 className="mr-3 size-4 shrink-0" />
            {t('Connections')}
          </TabsTrigger>
        )}
        {skillsAvailable && (
          <TabsTrigger
            value="skills"
            className="justify-start rounded-lg px-4 py-3 data-[state=active]:bg-muted data-[state=active]:shadow-none"
          >
            <Settings2 className="mr-3 size-4 shrink-0" />
            {t('Skills')}
          </TabsTrigger>
        )}
      </TabsList>
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <TabsContent value="general" className="px-6 pb-8 pt-6 md:px-10 md:pt-2">
          <LanguageSettings />
          <AppearanceSettings />
        </TabsContent>
        <TabsContent
          value="models"
          forceMount
          className="px-6 pb-8 pt-6 data-[state=inactive]:hidden md:px-10 md:pt-2"
        >
          <h2 className="mb-3 text-lg font-medium">{t('模型与 API Key')}</h2>
          <p className="mb-8 text-sm leading-relaxed text-muted-foreground">
            {t(
              'Key 将发送给本部署，在服务端加密保存，用于后台任务与恢复。请仅在你信任的部署中填写。',
            )}
          </p>
          {modelsVisited && <ModelSettingsForm userId={userId} initialProvider={initialProvider} />}
        </TabsContent>
        <TabsContent value="connections" className="px-6 pb-8 pt-6 md:px-10 md:pt-2">
          <McpConnections userId={userId} />
        </TabsContent>
        <TabsContent value="skills" className="px-6 pb-8 pt-6 md:px-10 md:pt-2">
          <Skills userId={userId} />
        </TabsContent>
      </ScrollArea>
    </Tabs>
  );
}
function AppearanceSettings() {
  const { t } = useLocale();
  const { theme = 'system', setTheme } = useTheme();
  const options = [
    { value: 'light', label: t('浅色'), Icon: Sun },
    { value: 'dark', label: t('深色'), Icon: Moon },
    { value: 'system', label: t('跟随系统'), Icon: Monitor },
  ];
  return (
    <section className="space-y-4 border-b py-8">
      <div className="space-y-2">
        <h2 className="font-medium">{t('外观')}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t('选择浅色、深色或跟随系统，设置保存在此浏览器中。')}
        </p>
      </div>
      <div role="group" aria-label={t('外观')} className="grid w-full max-w-sm grid-cols-3 gap-2">
        {options.map(({ value, label, Icon }) => (
          <Button
            key={value}
            variant="outline"
            aria-pressed={theme === value}
            onClick={() => setTheme(value)}
            className="h-10 min-w-0 gap-1.5 rounded-lg px-2 text-xs shadow-none aria-pressed:border-foreground/30 aria-pressed:bg-muted sm:gap-2 sm:px-3 sm:text-sm"
          >
            <Icon className="size-4 shrink-0" />
            {label}
          </Button>
        ))}
      </div>
    </section>
  );
}
function LanguageSettings() {
  const { t, locale, setLocale } = useLocale();
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-8 pt-2">
      <div className="min-w-0 flex-1 space-y-2">
        <h2 className="flex items-center gap-2 font-medium">
          <Languages className="size-4 md:hidden" />
          {t('语言')}
        </h2>
        <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
          {t('选择界面语言，设置保存在此浏览器中。')}
        </p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="secondary"
            aria-label={t('语言')}
            className="h-11 min-w-32 justify-between rounded-lg px-4 shadow-none"
          >
            {locale === 'en' ? 'English' : '中文'}
            <ChevronDown className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-36">
          <DropdownMenuRadioGroup
            value={locale}
            onValueChange={(value) => setLocale(value as Locale)}
          >
            <DropdownMenuRadioItem value="en">English</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="zh-CN">中文</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
