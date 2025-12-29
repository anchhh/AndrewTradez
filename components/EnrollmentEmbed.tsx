
import React, { useEffect, useRef } from 'react';
import { X, Lock, ShieldCheck } from 'lucide-react';

interface EnrollmentEmbedProps {
  isOpen: boolean;
  onClose: () => void;
}

const EnrollmentEmbed: React.FC<EnrollmentEmbedProps> = ({ isOpen, onClose }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';

      const script = document.createElement('script');
      script.src = "//embed.typeform.com/next/embed.js";
      script.async = true;
      document.body.appendChild(script);

      return () => {
        document.body.style.overflow = 'unset';
        if (document.body.contains(script)) {
          document.body.removeChild(script);
        }
      };
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-0 md:p-8 animate-in fade-in duration-300">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/90 backdrop-blur-3xl"
        onClick={onClose}
      />
      
      {/* Institutional Modal Architecture */}
      <div className="relative w-full max-w-5xl h-[100dvh] md:h-[85vh] bg-dark border-x md:border border-white/10 shadow-[0_0_120px_rgba(0,0,0,1)] flex flex-col overflow-hidden animate-in zoom-in-95 duration-500 rounded-none">
        
        {/* Secure Header Section */}
        <div className="flex justify-between items-center p-4 md:px-8 md:py-6 border-b border-white/5 bg-black/80 backdrop-blur-xl shrink-0">
          <div className="flex items-center gap-3 md:gap-4">
            <div className="w-8 h-8 md:w-10 md:h-10 rounded-none border border-accent/40 flex items-center justify-center bg-accent/5">
              <Lock size={14} className="text-accent" />
            </div>
            <div>
              <div className="font-syncopate text-[9px] md:text-xs tracking-[0.3em] text-white font-bold uppercase">MASTER_THE_MARKETS_INTAKE</div>
              <div className="text-[7px] md:text-[8px] text-accent/60 tracking-[0.2em] font-mono flex items-center gap-2 mt-0.5 uppercase">
                <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse"></span>
                SECURE_GATEWAY_ACTIVE
              </div>
            </div>
          </div>
          
          <button 
            onClick={onClose}
            className="group flex items-center gap-2 px-3 py-2 md:px-5 md:py-3 border border-white/10 hover:border-accent/40 transition-all bg-white/5"
            aria-label="Close Protocol"
          >
            <span className="font-syncopate text-[8px] md:text-[9px] tracking-widest text-gray-500 group-hover:text-accent transition-colors uppercase hidden md:inline">TERMINATE_SESSION</span>
            <X size={18} className="text-gray-400 group-hover:text-accent transition-colors" />
          </button>
        </div>

        {/* Form Container (Editable Area) */}
        <div className="flex-grow relative bg-[#080808]">
          <div 
            data-tf-live="01JP1WHF0DWSMXWR3VANNH81X1" 
            className="w-full h-full"
            ref={containerRef}
          ></div>
          
          {/* Terminal Scanline Visuals */}
          <div className="absolute inset-0 pointer-events-none opacity-[0.03] bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] z-10 bg-[length:100%_2px,3px_100%]"></div>
        </div>

        {/* Institutional Status Bar */}
        <div className="p-4 border-t border-white/5 bg-black/90 flex justify-between items-center px-6 md:px-8 shrink-0">
          <div className="text-[7px] md:text-[9px] text-gray-600 font-mono tracking-[0.2em] uppercase flex items-center gap-2.5">
            <ShieldCheck size={12} className="text-accent/40" />
            <span className="hidden xs:inline">STATUS: VERIFIED //</span> ACCESS: RESTRICTED
          </div>
          <div className="text-[7px] md:text-[9px] text-gray-500 font-mono tracking-tighter">
            {new Date().toISOString().split('T')[1].substring(0, 8)} UTC
          </div>
        </div>
      </div>

      <style>{`
        .tf-v4-popover-button, 
        .tf-v4-button {
          font-family: 'Syncopate', sans-serif !important;
          font-weight: 700 !important;
          text-transform: uppercase !important;
          letter-spacing: 0.2em !important;
          border-radius: 0 !important;
          background-color: #ffffff !important;
          color: #050505 !important;
          transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1) !important;
          font-size: 10px !important;
          padding: 16px 24px !important;
        }

        .tf-v4-popover-button:hover, 
        .tf-v4-button:hover {
          background-color: #00f0ff !important;
          transform: translateY(-2px) !important;
          box-shadow: 0 10px 40px rgba(0, 240, 255, 0.4) !important;
        }
        
        @media (max-width: 640px) {
          .tf-v4-button {
            width: 100% !important;
          }
        }
      `}</style>
    </div>
  );
};

export default EnrollmentEmbed;
