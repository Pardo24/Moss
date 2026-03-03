import type { Config } from '../App';
import { useT } from '../LangContext';
import appIcon from '../../assets/icons/icons/png/64x64.png';

type Props = { config: Config; updateConfig: (p: Partial<Config>) => void; next: () => void };

export default function StepWelcome({ next }: Props) {
  const { t } = useT();

  return (
    <div className="h-full flex flex-col items-center justify-center gap-8 px-8 text-center relative overflow-hidden">
      <div className="hero-glow" />

      <div className="flex flex-col items-center gap-4 relative z-10">
        <div className="logo-circle" style={{ padding: 6 }}>
          <img src={appIcon} alt="Caliu" style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 10 }} />
        </div>
        <div>
          <h1 className="text-5xl font-bold tracking-tight gradient-title">Caliu</h1>
          <p className="text-lg mt-2" style={{ color: 'var(--text-2)' }}>{t.welcome_subtitle}</p>
        </div>
      </div>

      <div className="card max-w-sm w-full p-5 text-left space-y-3 relative z-10">
        <p className="text-sm leading-relaxed" style={{ color: 'var(--text-2)' }}>{t.welcome_p1}</p>
        <p className="text-sm leading-relaxed" style={{ color: 'var(--text-3)' }}>{t.welcome_p2}</p>
      </div>

      <div className="flex flex-col items-center gap-3 relative z-10">
        <button onClick={next} className="btn-primary">{t.start}</button>
        <p className="text-xs" style={{ color: 'var(--text-3)' }}>{t.welcome_footer}</p>
      </div>
    </div>
  );
}
