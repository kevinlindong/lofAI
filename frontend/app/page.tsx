"use client"

import { AsciiAmbience } from "@/components/ascii-ambience"
import { MusicControls } from "@/components/music-controls"
import { Pet } from "@/components/pet"
import { PomodoroTimer } from "@/components/pomodoro-timer"
import { PageMenu } from "@/components/page-menu"
import { TodoList } from "@/components/todo-list"
import { useRadio } from "@/components/radio-provider"

export default function LofiGenerator() {
  const { petSignal, focusMode, setFocusMode, isLive, getLevel, handlePetEvent } = useRadio()

  return (
    <main className="site-shell">
      <AsciiAmbience />

      <div className="app-frame">
        <PageMenu />

        <div className="workspace-grid">
          <section id="radio" className="surface-card music-card" tabIndex={-1}>
            <div className="card-intro">
              <div>
                <p className="eyebrow">Generative radio</p>
                <h1>Find your flow.</h1>
              </div>
              <p className="card-note hidden sm:block">A live soundtrack that changes with you.</p>
            </div>
            <MusicControls />
          </section>

          <div className="side-stack">
            <section className="surface-card companion-card">
              <Pet
                signal={petSignal}
                focus={focusMode}
                playing={isLive}
                getLevel={getLevel}
              />
            </section>

            <section id="tasks" className="surface-card tasks-card" tabIndex={-1}>
              <TodoList onEvent={handlePetEvent} />
            </section>

            <section id="focus-timer" className="surface-card timer-card" tabIndex={-1}>
              <PomodoroTimer onRunningChange={setFocusMode} />
            </section>
          </div>
        </div>
      </div>
    </main>
  )
}
