import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { request, ApiError } from './api';
import { modelSettingsOptions, userKeys } from './queries';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
export function ModelSettingsDialog({
  userId,
  open,
  onOpenChange,
  initialProvider,
}: {
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialProvider?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>模型与 API Key</DialogTitle>
          <DialogDescription>
            Key 将发送给本部署，在服务端加密保存，用于后台任务与恢复。请仅在你信任的部署中填写。
          </DialogDescription>
        </DialogHeader>
        {open && <CredentialForm key={userId} userId={userId} initialProvider={initialProvider} />}
      </DialogContent>
    </Dialog>
  );
}
function CredentialForm({ userId, initialProvider }: { userId: string; initialProvider?: string }) {
  const client = useQueryClient(),
    query = useQuery(modelSettingsOptions(userId));
  const [choice, setProvider] = useState<string>(),
    [baseUrl, setBaseUrl] = useState<string>(),
    [key, setKey] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [confirmRemove, setConfirmRemove] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const preferred = initialProvider ?? query.data?.modelCatalog.defaultSelection.provider;
  const provider =
    choice ??
    (query.data?.providers.some((p) => p.id === preferred)
      ? preferred!
      : (query.data?.providers[0]?.id ?? ''));
  useEffect(() => {
    // Pin the initial choice for this form; a metadata refetch must not redirect a draft Key.
    if (choice === undefined && query.data) setProvider(provider);
  }, [choice, query.data, provider]);
  const current = query.data?.credentials.find((c) => c.provider === provider);
  const defaultUrl = query.data?.providers.find((p) => p.id === provider)?.baseUrl ?? '';
  const endpoint = baseUrl ?? current?.baseUrl ?? defaultUrl;
  useEffect(() => {
    if (baseUrl === undefined && current) setBaseUrl(endpoint);
  }, [baseUrl, current, endpoint]);
  const write = async (remove = false) => {
    if (busy || !current) return;
    setBusy(true);
    setMessage('');
    try {
      // Deliberately not a Query mutation: plaintext never enters the shared mutation cache.
      await request('/settings/model-credentials/' + encodeURIComponent(provider), {
        method: remove ? 'DELETE' : 'PUT',
        body: JSON.stringify(
          remove
            ? { expectedCurrentId: current.currentId }
            : { apiKey: key, baseUrl: endpoint, expectedCurrentId: current.currentId },
        ),
      });
      if (!alive.current) return;
      setKey('');
      setConfirmRemove(false);
      setMessage(remove ? '已移除，未完成请求将无法继续使用此 Key' : '已保存，尚未验证连接');
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
  if (query.isPending) return <p role="status">正在读取配置…</p>;
  if (query.error)
    return (
      <>
        <p role="alert">{query.error.message}</p>
        <Button onClick={() => void query.refetch()}>重试</Button>
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
        配置适用于输入框当前选择的模型。Base URL 需支持该模型的 API 协议。
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
      <p className="text-sm text-muted-foreground">
        当前来源：
        {current?.effectiveSource === 'user'
          ? '个人 Key'
          : current?.effectiveSource === 'server'
            ? '部署默认 Key'
            : '未配置'}
        {current?.updatedAt && <> · {new Date(current.updatedAt).toLocaleString()}</>}
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
          placeholder="填写个人 API Key"
        />
      </label>
      {!query.data?.credentialStorageReady && (
        <p role="alert" className="text-sm">
          部署未配置凭据加密主密钥，请联系部署者。
        </p>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">
        保存后，下次提交消息时应用新配置，并影响该会话尚未准备的模型调用（含排队消息和压缩）。
        已保存的步骤快照继续使用原版本；旧版本最多保留七天供恢复。移除会撤销全部版本。更换浏览器或清除
        Cookie 后无法找回访客身份。部署者可以解密 Key。
      </p>
      <div className="flex gap-2">
        <Button
          disabled={busy || !key.trim() || !endpoint.trim() || !query.data?.credentialStorageReady}
        >
          保存 Key
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy || !current?.configured}
          onClick={() => setConfirmRemove(true)}
        >
          移除 Key
        </Button>
      </div>
      {confirmRemove && (
        <div role="alert" className="space-y-2 rounded-lg border p-3 text-sm">
          <p>移除会撤销当前配置的全部 Key 版本，已提交任务的后续调用与恢复将失败。</p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void write(true)}
            >
              确认移除全部版本
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmRemove(false)}
            >
              取消
            </Button>
          </div>
        </div>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </form>
  );
}
