import { documentationAvailable } from '../../../packages/shared/src/release-capabilities';
import { useEffect, useState } from 'react';
import { api } from './dashboard-api';

type Module = { id: string; enabled: boolean; capabilities: string[]; navigation: { label: string; path: string } };
export function useModuleNavigation() {
  const [documentation, setDocumentation] = useState<Module>();
  const [hours, setHours] = useState<Module>(); const [loading, setLoading] = useState(true); const [error, setError] = useState(false); const [version, setVersion] = useState(0);
  useEffect(() => {
    let sequence = 0; let active = true;
    const load = async () => {
      const token = ++sequence; setLoading(true);
      try {
        const value = await api<{ modules: Module[]; capabilities: string[] }>('/platform/modules');
        if (!value || !Array.isArray(value.modules) || !Array.isArray(value.capabilities) || !value.capabilities.every(item => typeof item === 'string')) throw Error('Unavailable module access');
        const module = value.modules.find(item => item.id === 'hour-tracking');
        if (!module || typeof module.enabled !== 'boolean' || !Array.isArray(module.capabilities) || !module.capabilities.includes('hours.manage') || module.navigation?.path !== '/hours' || typeof module.navigation.label !== 'string' || module.navigation.label.length > 100) throw Error('Invalid module descriptor');
        const doc = value.modules.find(item => item.id === 'activity-documentation');
        if (active && token === sequence) { setDocumentation(documentationAvailable && module.enabled && doc?.enabled === true && doc.navigation?.path === '/documentation' && doc.capabilities?.includes('documentation.manage') && value.capabilities.includes('documentation.manage') ? doc : undefined); setHours(module.enabled && value.capabilities.includes('hours.manage') ? module : undefined); setError(false); }
      } catch { if (active && token === sequence) { setDocumentation(undefined); setHours(undefined); setError(true); } } finally { if (active && token === sequence) setLoading(false); }
    };
    void load(); window.addEventListener('focus', load); return () => { active = false; window.removeEventListener('focus', load); };
  }, [version]);
  return { hours, documentation, loading, error, reload: () => setVersion(value => value + 1) };
}
