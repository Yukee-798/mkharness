import { useLocale } from '../app/locale';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { request, ApiError } from '../api';
import { modelSettingsOptions, userKeys } from '../queries';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Checkbox } from '../ui/checkbox';
import { readModelKey, rememberModelKey } from './local-model-key';
import type { CredentialMetadata } from '../../shared/model-settings';
export function ModelSettingsForm({
  userId,
  initialProvider,
}: {
  userId: string;
  initialProvider?: string;
}) {
  return <CredentialForm key={userId} userId={userId} initialProvider={initialProvider} />;
}
function CredentialForm({ userId, initialProvider }: { userId: string; initialProvider?: string }) {
  const { t, locale } = useLocale();
  const client = useQueryClient(),
    query = useQuery(modelSettingsOptions(userId));
  const [choice, setProvider] = useState<string>(),
    [baseUrl, setBaseUrl] = useState<string>(),
    [modelId, setModelId] = useState<string>(),
    [key, setKey] = useState(''),
    [remember, setRemember] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const preferred = initialProvider ?? query.data?.modelCatalog.defaultSelection.provider;
  const initial =
    choice ??
    (query.data?.providers.some((p) => p.id === preferred)
      ? preferred!
      : (query.data?.providers[0]?.id ?? ''));
  useEffect(() => {
    // Pin the initial choice for this form; a metadata refetch must not redirect a draft Key.
    if (choice === undefined && query.data) setProvider(initial);
  }, [choice, query.data, initial]);
  const original = query.data?.credentials.find((c) => c.provider === initial);
  const defaultUrl = query.data?.providers.find((p) => p.id === initial)?.baseUrl ?? '';
  const endpoint = baseUrl ?? original?.baseUrl ?? defaultUrl;
  // Known endpoints select their native Pi protocol; custom gateways retain the initial protocol.
  const provider =
    query.data?.providers.find(
      (p) => p.baseUrl.replace(/\/$/, '') === endpoint.trim().replace(/\/$/, ''),
    )?.id ?? initial;
  const current = query.data?.credentials.find((c) => c.provider === provider);
  useEffect(() => {
    if (baseUrl === undefined && current) setBaseUrl(endpoint);
  }, [baseUrl, current, endpoint]);
  const modelName =
    modelId ??
    current?.modelId ??
    (query.data?.modelCatalog.defaultSelection.provider === provider
      ? query.data.modelCatalog.defaultSelection.modelId
      : query.data?.providers.find((p) => p.id === provider)?.defaultModelId) ??
    '';
  const initialized = useRef(false);
  useEffect(() => {
    if (!current || initialized.current) return;
    initialized.current = true;
    setModelId(modelName);
    const saved = readModelKey(userId, provider, current.currentId);
    if (saved) {
      setKey(saved.apiKey);
      setRemember(true);
    }
  }, [current, modelName, provider, userId]);
  const write = async () => {
    if (busy || !current) return;
    setBusy(true);
    setMessage('');
    try {
      // Deliberately not a Query mutation: plaintext never enters the shared mutation cache.
      const saved = await request<CredentialMetadata>(
        '/settings/model-credentials/' + encodeURIComponent(provider),
        {
          method: 'PUT',
          body: JSON.stringify({
            apiKey: key,
            baseUrl: endpoint,
            modelId: modelName,
            expectedCurrentId: current.currentId,
          }),
        },
      );
      if (!alive.current) return;
      const remembered = rememberModelKey(
        userId,
        provider,
        remember && saved.currentId
          ? { currentId: saved.currentId, apiKey: key.trim() }
          : undefined,
      );
      if (!remember) setKey('');
      setMessage(
        remembered
          ? '已保存，尚未验证连接'
          : remember
            ? '服务端已保存，但浏览器本地保存失败'
            : '服务端已保存，但无法清除浏览器本地副本',
      );
      await client.invalidateQueries({ queryKey: userKeys(userId).models });
    } catch (e) {
      if (alive.current) {
        setMessage(e instanceof ApiError ? e.message : '保存失败，请重试');
        if (e instanceof ApiError && e.status === 409) void query.refetch();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  if (query.isPending) return <p role="status">{t('正在读取配置…')}</p>;
  if (query.error)
    return (
      <>
        <p role="alert">{t(query.error.message)}</p>
        <Button onClick={() => void query.refetch()}>{t('重试')}</Button>
      </>
    );
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void write();
      }}
    >
      <p className="text-sm text-muted-foreground">
        {t('模型名使用 API 标识；Base URL 需支持该模型的 API 协议。')}
      </p>
      <label className="block space-y-2">
        Base URL
        <Input
          aria-label="Base URL"
          type="url"
          required
          autoComplete="off"
          spellCheck={false}
          value={endpoint}
          disabled={busy || !query.data?.credentialStorageReady}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.example.com/v1"
        />
      </label>
      <label className="block space-y-2">
        {t('模型名')}
        <Input
          aria-label={t('模型名')}
          required
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
          value={modelName}
          disabled={busy || !query.data?.credentialStorageReady}
          onChange={(e) => setModelId(e.target.value)}
          placeholder="deepseek-flash"
        />
      </label>
      <p className="text-sm text-muted-foreground">
        {t('当前来源：')}
        {current?.effectiveSource === 'user'
          ? t('个人 Key')
          : current?.effectiveSource === 'server'
            ? t('部署默认 Key')
            : t('未配置')}
        {current?.updatedAt && <> · {new Date(current.updatedAt).toLocaleString(locale)}</>}
      </p>
      <label className="block space-y-2">
        API Key
        <Input
          aria-label="API Key"
          type="password"
          autoComplete="off"
          value={key}
          disabled={busy || !query.data?.credentialStorageReady}
          onChange={(e) => setKey(e.target.value)}
          placeholder={t('填写个人 API Key')}
        />
      </label>
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            aria-label={t('在此浏览器记住 API Key')}
            checked={remember}
            disabled={busy}
            onCheckedChange={(checked) => {
              const enabled = checked === true;
              setRemember(enabled);
              if (!enabled && !rememberModelKey(userId, provider))
                setMessage('无法清除浏览器本地保存，请检查浏览器存储设置');
            }}
          />
          {t('在此浏览器记住 API Key')}
        </label>
        <p className="text-xs text-muted-foreground">
          {t('可选：以明文保存在 localStorage，供再次填写；页面脚本可读取。退出后清除。')}
        </p>
      </div>
      {!query.data?.credentialStorageReady && (
        <p role="alert" className="text-sm">
          {t('部署未配置凭据加密主密钥，请联系部署者。')}
        </p>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t(
          '保存后，下次提交消息时应用新配置，并影响该会话尚未准备的模型调用（含排队消息和压缩）。 已保存的步骤快照继续使用原版本；旧版本最多保留七天供恢复。部署者可以解密 Key。',
        )}
      </p>
      <div className="flex gap-2">
        <Button
          disabled={
            busy ||
            !key.trim() ||
            !endpoint.trim() ||
            !modelName.trim() ||
            !query.data?.credentialStorageReady
          }
        >
          {t('保存配置')}
        </Button>
      </div>
      {message && (
        <p role="status" className="text-sm">
          {t(message)}
        </p>
      )}
    </form>
  );
}
