import React, { useEffect } from 'react';
import { X, ShieldAlert, Scale, AlertTriangle } from 'lucide-react';

interface TermsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const TermsModal: React.FC<TermsModalProps> = ({ isOpen, onClose }) => {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 md:p-8 animate-in fade-in duration-300">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/95 backdrop-blur-2xl"
        onClick={onClose}
      />
      
      {/* Legal Protocol Container */}
      <div className="relative w-full max-w-3xl max-h-[90vh] bg-dark border border-white/10 shadow-[0_0_100px_rgba(0,0,0,1)] flex flex-col overflow-hidden animate-in zoom-in-95 duration-500 rounded-none">
        
        {/* Header */}
        <div className="flex justify-between items-center p-6 border-b border-white/5 bg-black/50 shrink-0">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 border border-accent/40 flex items-center justify-center bg-accent/5">
              <Scale size={18} className="text-accent" />
            </div>
            <div>
              <div className="font-syncopate text-xs tracking-[0.3em] text-white font-bold uppercase">LEGAL_PROTOCOL_V.25</div>
              <div className="text-[8px] text-accent/60 tracking-[0.2em] font-mono uppercase">SYSTEM_TERMS_AND_DISCLOSURES</div>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="p-2 border border-white/10 hover:border-accent/40 transition-all bg-white/5"
          >
            <X size={20} className="text-gray-400 hover:text-accent transition-colors" />
          </button>
        </div>

        {/* Content Area */}
        <div className="flex-grow overflow-y-auto p-8 md:p-12 font-mono text-xs leading-relaxed space-y-10 custom-scrollbar">
          
          <section className="space-y-4">
            <div className="flex items-center gap-3 text-accent mb-2">
              <ShieldAlert size={16} />
              <h3 className="font-syncopate text-[10px] tracking-widest font-bold uppercase">01 // RISK_DISCLOSURE_PROTOCOL</h3>
            </div>
            <div className="text-gray-400 space-y-4">
              <p>
                <span className="text-white font-bold underline">WE ARE NOT FINANCIAL ADVISORS</span>. We strongly advise you to consult with a certified financial professional before purchasing any securities or assets with your capital. 
              </p>
              <p>
                Nothing within this environment, the server, or associated communications constitutes professional and/or financial advice. None of the information provided constitutes a comprehensive or complete statement of the matters discussed or the law relating thereto. We take <span className="text-white">ZERO RESPONSIBILITY</span> for any securities or assets you purchase; it is entirely your decision.
              </p>
              <p>
                This investing group's primary purpose is <span className="text-white">EDUCATIONAL</span> and for connecting with like-minded individuals. Due to our channels being open to the public, be strictly aware that <span className="text-accent font-bold uppercase">SCAMS MAY POP INTO YOUR DMs</span>. 
              </p>
              <p>
                <span className="text-white font-bold uppercase italic">SECURITY PROTOCOL:</span> We will <span className="text-white">NEVER</span> ask you to send us money to invest for you. We will <span className="text-white">NEVER</span> offer to trade your money for you. You purchase assets at your own choice and decision; all actions taken are your sole responsibility.
              </p>
            </div>
          </section>

          <section className="space-y-4">
            <div className="flex items-center gap-3 text-accent mb-2">
              <AlertTriangle size={16} />
              <h3 className="font-syncopate text-[10px] tracking-widest font-bold uppercase">02 // NO_REFUND_POLICY</h3>
            </div>
            <p className="text-gray-400">
              Due to the digital nature of our proprietary materials, 300+ hour intel repository, and immediate access to the head mentor, <span className="text-white font-bold">ALL SALES ARE FINAL</span>. There are absolutely no refunds under any circumstances once access to the Inner Circle protocol has been granted.
            </p>
          </section>

          <section className="space-y-4">
            <div className="flex items-center gap-3 text-accent mb-2">
              <ShieldAlert size={16} />
              <h3 className="font-syncopate text-[10px] tracking-widest font-bold uppercase">03 // 1-ON-1_SCHEDULING</h3>
            </div>
            <p className="text-gray-400">
              The premium 1-on-1 mentorship sessions (5 sessions weekly, Mon-Fri) are <span className="text-white font-bold">ENTIRELY SCHEDULED BY THE CUSTOMER</span>. It is the student's responsibility to utilize the booking gateway or direct line access to secure their time slots. Failure to schedule sessions does not entitle the customer to credit or extensions.
            </p>
          </section>

          <section className="space-y-4">
            <div className="flex items-center gap-3 text-accent mb-2">
              <ShieldAlert size={16} />
              <h3 className="font-syncopate text-[10px] tracking-widest font-bold uppercase">04 // RECIPROCITY_OF_EFFORT</h3>
            </div>
            <p className="text-gray-400">
              The "Master the Markets" program is an elite performance environment. All assignments, trade recaps, and homework given by the mentor must be completed with precision. The student acknowledges that <span className="text-white font-bold">TRADING RESULTS ARE DIRECTLY RECIPROCATED BY THE WORK INJECTED</span> into the study. We provide the edge; you must provide the execution and discipline.
            </p>
          </section>

          <div className="pt-8 border-t border-white/5 text-center">
            <p className="text-[8px] text-gray-600 uppercase tracking-[0.2em]">
              ACKNOWLEDGING THESE TERMS IS MANDATORY FOR PROTOCOL ACCESS.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 bg-black border-t border-white/5 flex justify-center">
          <button 
            onClick={onClose}
            className="px-10 py-4 bg-white text-dark font-syncopate font-bold text-[10px] tracking-widest hover:bg-accent transition-all uppercase"
          >
            I_UNDERSTAND_AND_ACCEPT
          </button>
        </div>
      </div>
      
      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
          display: block;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: rgba(255, 255, 255, 0.02);
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(0, 240, 255, 0.2);
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(0, 240, 255, 0.5);
        }
      `}</style>
    </div>
  );
};

export default TermsModal;