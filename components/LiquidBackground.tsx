
import React from 'react';

const LiquidBackground: React.FC = () => {
  return (
    <div className="fixed inset-0 -z-50 overflow-hidden bg-[#050505]">
      <svg className="absolute h-0 w-0">
        <defs>
          <filter id="liquid">
            <feTurbulence type="fractalNoise" baseFrequency="0.01 0.01" numOctaves="3" result="noise" seed="2">
              <animate attributeName="baseFrequency" dur="15s" values="0.01 0.01; 0.015 0.02; 0.01 0.01" repeatCount="indefinite" />
            </feTurbulence>
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="50" />
          </filter>
        </defs>
      </svg>
      
      {/* Cartesian Gridwork Layer */}
      <div className="absolute inset-0 opacity-10" 
           style={{ backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)', backgroundSize: '100px 100px' }}>
      </div>

      <div className="relative w-full h-full liquid-filter opacity-30">
        <div className="blob absolute -top-[10%] -left-[10%] w-[600px] h-[600px] bg-gradient-to-br from-[#444] via-[#fff] to-[#888]"></div>
        <div className="blob absolute -bottom-[10%] -right-[10%] w-[800px] h-[800px] bg-gradient-to-tr from-[#333] via-[#e2e2e2] to-[#222]" style={{ animationDelay: '-5s' }}></div>
      </div>
      
      {/* Molten Overlay */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-dark/50 to-dark"></div>
    </div>
  );
};

export default LiquidBackground;
