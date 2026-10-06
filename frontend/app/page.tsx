"use client"

import { AsciiAmbience } from "@/components/ascii-ambience"
import { Desk } from "@/components/desk/desk"
import { LandingNews } from "@/components/landing-news"
import { PageMenu } from "@/components/page-menu"

// Everything on the page is a widget on the desk; the name stays for screen readers.
export default function LofiGenerator() {
  return (
    <main className="site-shell">
      <h1 className="sr-only">lofAI</h1>
      <AsciiAmbience />
      <PageMenu />
      <Desk />
      <LandingNews />
    </main>
  )
}
