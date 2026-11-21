import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/modules/auth';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsSection from '@/modules/settings/SettingsSection';
import { api, readApiJson } from '@/shared/api';
import { Button, Input } from '@/shared/ui';

type DirectoryAccount = { id: number; username: string; directories: string[]; models: string[] | null; hostWorkspaceAccess: boolean };
type ProjectOption = { path: string; displayName: string };
type ModelOption = { id: string; label: string };
type DirectoryAccountsCatalog = {
  accounts: DirectoryAccount[];
  projects: ProjectOption[];
  defaultModel: string;
  models: ModelOption[];
};

function ProjectAccessPicker({ projects, initialValue = [] }: { projects: ProjectOption[]; initialValue?: string[] }) {
  const { t } = useTranslation('settings');
  // Filter the project choices while keeping selections made under other search terms.
  const [search, setSearch] = useState('');
  // Only currently selectable projects are submitted, including selections hidden by the filter.
  const [selected, setSelected] = useState(() => new Set(projects.filter((project) => initialValue.includes(project.path)).map((project) => project.path)));
  const query = search.trim().toLowerCase();
  const matches = projects.filter((project) => `${project.displayName} ${project.path}`.toLowerCase().includes(query));
  const unrecognized = initialValue.some((entry) => !projects.some((project) => project.path === entry));

  function toggle(projectPath: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(projectPath);
      else next.delete(projectPath);
      return next;
    });
  }

  return (
    <div className="space-y-2 text-sm">
      {unrecognized && <p className="text-sm text-muted-foreground">{t('directoryAccess.unrecognizedPaths')}</p>}
      <details className="rounded-md border border-border">
        <summary className="cursor-pointer px-3 py-2 font-medium">{t('directoryAccess.paths')} ({selected.size})</summary>
        <div className="space-y-2 border-t border-border p-2">
          <Input aria-label={t('directoryAccess.searchProjects')} placeholder={t('directoryAccess.searchProjects')} value={search} onChange={(event) => setSearch(event.target.value)} />
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {matches.map((project) => (
              <label key={project.path} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
                <input type="checkbox" className="mt-1" checked={selected.has(project.path)} onChange={(event) => toggle(project.path, event.target.checked)} />
                <span className="min-w-0"><span className="block truncate">{project.displayName}</span><span className="block break-all text-xs text-muted-foreground">{project.path}</span></span>
              </label>
            ))}
            {matches.length === 0 && <p className="p-2 text-muted-foreground">{t('directoryAccess.noMatches')}</p>}
          </div>
        </div>
      </details>
      {[...selected].map((projectPath) => <input key={projectPath} type="hidden" name="directories" value={projectPath} />)}
    </div>
  );
}

function ModelAccessPicker({ models, initialValue }: { models: ModelOption[]; initialValue: string[] }) {
  const { t } = useTranslation('settings');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(() => new Set(initialValue));
  const options = new Map(models.map((model) => [model.id, model]));
  for (const id of initialValue) {
    if (!options.has(id)) options.set(id, { id, label: id });
  }
  const query = search.trim().toLowerCase();
  const matches = [...options.values()].filter(({ id, label }) =>
    id.toLowerCase().includes(query) || label.toLowerCase().includes(query));

  return (
    <div>
      <details className="rounded-md border border-border text-sm">
        <summary className="cursor-pointer px-3 py-2 font-medium">{t('directoryAccess.allowedModels')} ({selected.size})</summary>
        <div className="space-y-2 border-t border-border p-2">
          <Input aria-label={t('directoryAccess.searchModels')} placeholder={t('directoryAccess.searchModels')} value={search} onChange={(event) => setSearch(event.target.value)} />
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {matches.map(({ id, label }) => (
              <label key={id} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
                <input type="checkbox" className="mt-1" checked={selected.has(id)} onChange={(event) => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(id);
                  else next.delete(id);
                  setSelected(next);
                }} />
                <span className="min-w-0">
                  <span className="block break-all">{label}</span>
                  {label !== id && <span className="block break-all text-xs text-muted-foreground">{id}</span>}
                </span>
              </label>
            ))}
            {matches.length === 0 && <p className="p-2 text-muted-foreground">{t('directoryAccess.noMatchingModels')}</p>}
          </div>
        </div>
      </details>
      {[...selected].map((id) => <input key={id} type="hidden" name="models" value={id} />)}
    </div>
  );
}

/** Used by Settings to create login accounts and edit their accessible directories. */
export default function DirectoryAccountsTab() {
  const { t } = useTranslation('settings');
  const { user, logout } = useAuth();
  // The list is loaded when the tab opens and updated after a successful save.
  const [catalog, setCatalog] = useState<DirectoryAccountsCatalog | null>(null);
  const accounts = catalog?.accounts ?? null;
  // Disable writes until the current form is saved and show its result.
  const [status, setStatus] = useState<{ pending: true } | { pending: false; error?: string; saved?: boolean }>({ pending: false });

  useEffect(() => {
    const controller = new AbortController();
    void api.directoryAccess.accounts(controller.signal)
      .then(readApiJson<DirectoryAccountsCatalog>)
      .then(setCatalog)
      .catch(() => {
        if (!controller.signal.aborted) setStatus({ pending: false, error: t('directoryAccess.unavailable') });
      });
    return () => controller.abort();
  }, [t]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>, userId?: number) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const directories = formData.getAll('directories').map(String);
    const models = formData.getAll('models').map(String);
    setStatus({ pending: true });
    try {
      if (userId === undefined) {
        const { account } = await readApiJson<{ account: DirectoryAccount }>(await api.directoryAccess.createAccount({
          username: String(formData.get('username') ?? ''),
          password: String(formData.get('password') ?? ''),
          directories,
          models,
        }));
        setCatalog((current) => current && { ...current, accounts: [...current.accounts, account].sort((left, right) => left.username.localeCompare(right.username)) });
        form.reset();
      } else {
        const hostWorkspaceAccess = formData.has('hostWorkspaceAccess');
        const previousAccount = accounts?.find((account) => account.id === userId);
        const result = await readApiJson<Pick<DirectoryAccount, 'directories' | 'models' | 'hostWorkspaceAccess'>>(
          await api.directoryAccess.updateDirectories(
            userId, directories, previousAccount?.hostWorkspaceAccess ? undefined : models, hostWorkspaceAccess,
          ),
        );
        setCatalog((current) => current && { ...current, accounts: current.accounts.map((account) => account.id === userId ? { ...account, ...result } : account) });
      }
      setStatus({ pending: false, saved: true });
    } catch (error) {
      setStatus({ pending: false, error: error instanceof Error ? error.message : t('directoryAccess.unavailable') });
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="break-all text-sm text-muted-foreground">{user?.username}</p>
        <Button type="button" variant="outline" size="sm" onClick={logout}>{t('directoryAccess.logout')}</Button>
      </div>
      <SettingsSection title={t('directoryAccess.users')} description={t('directoryAccess.usersHint')}>
        {status.pending ? (
          <p role="status" className="text-sm">{t('directoryAccess.saving')}</p>
        ) : status.error ? (
          <p role="alert" className="text-sm text-destructive">{status.error}</p>
        ) : status.saved && (
          <p role="status" className="text-sm">{t('directoryAccess.saved')}</p>
        )}
        {accounts === null ? (
          !('error' in status && status.error) && <p role="status" className="text-sm">{t('directoryAccess.loading')}</p>
        ) : accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('directoryAccess.noMembers')}</p>
        ) : accounts.map((account) => (
          <SettingsCard key={account.id} className="p-4">
            <form onSubmit={(event) => void handleSubmit(event, account.id)} aria-label={account.username} className="space-y-3">
              <h4 className="break-all font-medium">{account.username}</h4>
              <ProjectAccessPicker projects={catalog?.projects ?? []} initialValue={account.directories} />
              {catalog && !account.hostWorkspaceAccess && (
                <ModelAccessPicker models={catalog.models} initialValue={account.models ?? [catalog.defaultModel]} />
              )}
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="hostWorkspaceAccess" defaultChecked={account.hostWorkspaceAccess} className="mt-1" />
                <span>
                  <span className="block font-medium">{t('directoryAccess.hostWorkspaceAccess')}</span>
                  <span className="block text-muted-foreground">{t('directoryAccess.hostWorkspaceAccessHint')}</span>
                </span>
              </label>
              <Button type="submit" size="sm" disabled={status.pending}>{t('directoryAccess.saveAccess')}</Button>
            </form>
          </SettingsCard>
        ))}
      </SettingsSection>

      {catalog && (
        <SettingsSection title={t('directoryAccess.createAccount')}>
          <SettingsCard className="p-4">
            <form onSubmit={(event) => void handleSubmit(event)} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5 text-sm font-medium">
                  <span>{t('account.username')}</span>
                  <Input name="username" required minLength={3} maxLength={64} autoComplete="off" />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  <span>{t('directoryAccess.password')}</span>
                  <Input name="password" required minLength={6} type="password" autoComplete="new-password" />
                </label>
              </div>
              <ProjectAccessPicker key={catalog.accounts.length} projects={catalog.projects} />
              <ModelAccessPicker key={catalog.accounts.length} models={catalog.models} initialValue={[catalog.defaultModel]} />
              <Button type="submit" size="sm" disabled={status.pending}>{t('directoryAccess.createAccount')}</Button>
            </form>
          </SettingsCard>
        </SettingsSection>
      )}
    </>
  );
}
