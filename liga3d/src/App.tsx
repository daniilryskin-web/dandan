import { useEffect, useState } from 'react';
import { useStore } from './state/store';
import { BattleView } from './ui/BattleView';
import { LocationView } from './ui/LocationView';
import { BagModal, DexModal, EvolutionModal, LearnMoveModal, MapModal, SettingsModal, ShopModal, StorageModal } from './ui/Modals';
import { PokemonModal } from './ui/PokemonModal';
import { Sidebar, TopBar } from './ui/Sidebar';
import { TitleScreen } from './ui/TitleScreen';

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} type="button" className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </button>
      ))}
    </div>
  );
}

function GameScreen() {
  const game = useStore((s) => s.game)!;
  const modal = useStore((s) => s.modal);
  const modalArg = useStore((s) => s.modalArg);
  const inBattle = !!game.battle;
  return (
    <div className="game">
      <TopBar />
      <main className="game-main">
        <section className="stage">{inBattle ? <BattleView key={game.battle!.enemyTeam[0].uid} /> : <LocationView />}</section>
        <Sidebar />
      </main>
      {modal === 'bag' && <BagModal />}
      {modal === 'shop' && <ShopModal />}
      {modal === 'storage' && <StorageModal />}
      {modal === 'dex' && <DexModal />}
      {modal === 'map' && <MapModal />}
      {modal === 'settings' && <SettingsModal />}
      {modal === 'pokemon' && modalArg && <PokemonModal uid={modalArg} />}
      {!inBattle && game.pendingLearn.length > 0 && <LearnMoveModal />}
      {!inBattle && game.pendingLearn.length === 0 && game.pendingEvolution.length > 0 && <EvolutionModal />}
    </div>
  );
}

export function App() {
  const game = useStore((s) => s.game);
  const loadSaved = useStore((s) => s.loadSaved);
  const setModal = useStore((s) => s.setModal);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    loadSaved();
    setReady(true);
  }, [loadSaved]);
  if (!ready) return null;
  return (
    <>
      {game ? <GameScreen /> : <TitleScreen />}
      {!game && <SettingsShortcut onOpen={() => setModal('settings')} />}
      <Toasts />
    </>
  );
}

function SettingsShortcut({ onOpen }: { onOpen: () => void }) {
  const modal = useStore((s) => s.modal);
  return (
    <>
      <button className="icon-btn corner" type="button" onClick={onOpen} title="Настройки">
        ⚙
      </button>
      {modal === 'settings' && <SettingsModal />}
    </>
  );
}
