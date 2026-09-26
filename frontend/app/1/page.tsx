import LofiGenerator from "../page"

// A plain re-export makes Next treat /1 as dynamic, which a static export
// cannot build; rendering the original page from a component keeps it static.
export default function OriginalPage() {
  return <LofiGenerator />
}
