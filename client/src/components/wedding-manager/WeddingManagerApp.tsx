// @ts-expect-error - legacy JS/JSX pages
import Dashboard from './pages/Dashboard';
// @ts-expect-error - legacy JS/JSX pages
import PrintPage from './pages/PrintPage';
// @ts-expect-error - legacy JS/JSX context
import { ModalProvider } from './context/ModalContext';
import './index.css';

type WeddingManagerAppProps = {
  /** When embedded in ROS, current staff display name — skips “who did this?” salesperson picker. */
  rosActorName?: string | null;
  initialPartyId?: string | null;
  onInitialPartyConsumed?: () => void;
};

const WeddingManagerApp = ({
  rosActorName = null,
  initialPartyId = null,
  onInitialPartyConsumed,
}: WeddingManagerAppProps) => {
  // Check for print mode
  const params = new URLSearchParams(window.location.search);
  const printId = params.get('print');

  if (printId) {
    return (
      <ModalProvider rosActorName={rosActorName}>
        <div className="wedding-manager-root">
          <PrintPage partyId={printId} />
        </div>
      </ModalProvider>
    );
  }

  return (
    <ModalProvider rosActorName={rosActorName}>
      <div className="wedding-manager-root min-h-full w-full pb-[env(safe-area-inset-bottom)] font-sans text-app-text">
        <Dashboard
          initialPartyId={initialPartyId}
          onInitialPartyConsumed={onInitialPartyConsumed}
        />
      </div>
    </ModalProvider>
  );
};

export default WeddingManagerApp;
