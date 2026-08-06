import React, { useEffect, useRef } from "react";
import { useSimulationStore } from "../useSimulationStore";

const MODE_LABEL = {
  connecting: { text: "LINKING", tone: "amber" },
  real_ai: { text: "LIVE MODEL", tone: "green" },
  sensor_offline: { text: "SENSOR OFF", tone: "red" },
};

export default function OnboardComputerConsole() {
  const lines = useSimulationStore((state) => state.consoleLines);
  const detectionMode = useSimulationStore((state) => state.detectionMode);
  const aiHealth = useSimulationStore((state) => state.aiHealth);
  const scrollRef = useRef(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines]);

  const mode = MODE_LABEL[detectionMode] || MODE_LABEL.connecting;

  return (
    <div className="onboard-console">
      <div className="onboard-console-header">
        <span className="onboard-console-title">ONBOARD COMPUTER</span>
        <span className="onboard-console-host mono">
          {aiHealth ? aiHealth.model : "sar-companion"}
        </span>
        <span className={`onboard-console-mode ${mode.tone}`}>{mode.text}</span>
      </div>

      <div className="onboard-console-body mono" ref={scrollRef}>
        {lines.length === 0 ? (
          <div className="onboard-line">
            <span className="onboard-source SYS">SYS</span>
            <span className="onboard-text dim">booting companion computer…</span>
          </div>
        ) : (
          lines.map((line) => (
            <div className="onboard-line" key={line.id}>
              <span className="onboard-time">{line.time}</span>
              <span className={`onboard-source ${line.source}`}>{line.source}</span>
              <span className="onboard-text">{line.text}</span>
            </div>
          ))
        )}
        <div className="onboard-line">
          <span className="onboard-prompt">sar@companion:~$</span>
          <span className="onboard-cursor" />
        </div>
      </div>
    </div>
  );
}
