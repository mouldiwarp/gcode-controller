// Port of packages/shared/test/resume.test.ts and progress.test.ts.

import Foundation
import Testing
@testable import GCCCore

@Suite struct ResumeTests {
    let program = [
        "(test)", "G21 G90 G17 G94", "G0 Z5", "M3 S12000", "G4 P2", "G0 X10 Y10", "G1 Z-1 F300", "G1 X50 F1000", "G1 Y40", "G20",
        "G1 X1", "M5",
    ].joined(separator: "\n")

    func index(_ text: String) -> Int { streamableLines(program).firstIndex { $0.text == text }! }

    @Test func knowsTheModesAndThePositionBeforeALine() {
        let st = stateAt(program, index("G1Y40"))
        #expect(!st.inches && st.absolute && st.plane == 17 && st.motion == 1 && st.feed == 1000)
        #expect(st.spindle == "M3" && st.speed == 12000 && st.pos == [50, 10, -1])
        let later = stateAt(program, index("G1X1"))
        #expect(later.inches && later.pos == [50, 40, -1])
    }

    @Test func liftsMovesOverSpinsUpLowersAndRestoresTheModes() throws {
        let plan = try planResume(program, index("G1Y40"), .init(travelZ: 5, spinup: 4, plungeFeed: 300))
        #expect(plan.preamble == ["G21G90G17G94G54", "G0Z5", "G0X50Y10", "M3S12000", "G4P4", "G1Z-1F300", "G21G90G1", "F1000"])
        #expect(plan.start == Vec3(50, 10, -1))
    }

    @Test func restoresInchesAfterMovingInMm() throws {
        let plan = try planResume(program, index("G1X1"), .init(travelZ: 5, spinup: 0, plungeFeed: 300))
        #expect(Array(plan.preamble.suffix(2)) == ["G20G90G1", "F1000"])
        #expect(plan.preamble[2] == "G0X50Y40")
    }

    @Test func refusesALineBeforeTheProgramHasSaidWhereTheToolIs() {
        #expect {
            try planResume(program, index("G0Z5"), .init(travelZ: 5, spinup: 4, plungeFeed: 300))
        } throws: { ($0 as? ResumeError)?.description.contains("isn't known") == true }
    }

    @Test func tellsMovesFromOtherLines() {
        #expect(isMotionLine("G1X5"))
        #expect(isMotionLine("X5Y2"))
        #expect(!isMotionLine("G4P2"))
        #expect(!isMotionLine("G04P2"))
        #expect(!isMotionLine("G10L20P0X0"))
        #expect(!isMotionLine("G92X0"))
        #expect(!isMotionLine("M3S1000"))
        #expect(isMotionLine("G43Z5"))
        #expect(isMotionLine("G40G1X5"))
    }

    @Test func showsTheSourceLineOfAResumePoint() {
        #expect(sourceLineText(program, index("G1Y40")) == StreamLine(text: "G1 Y40", source: 8))
        #expect(sourceLineText(program, 999) == nil)
    }
}

@Suite struct ProgressTests {
    let text = ["(t)", "G21 G90", "G0 X0 Y0 Z0", "G1 X100 F600", "G4 P2", "G1 Y60 F1200"].joined(separator: "\n")

    @Test func timesEachLineByDistanceAndFeedAndDwellsByLength() {
        let m = progressModel(text, options: .init(rapidRate: 5000))
        #expect(m.dur == [0, 0, 10, 2, 3])
        #expect(m.start == [0, 0, 0, 10, 12])
        #expect(m.total == 15)
    }

    @Test func countsHowFarAlongTheCurrentLineTheToolIs() {
        let m = progressModel(text, options: .init(rapidRate: 5000))
        #expect(close(secondsDone(m, 2, Vec3(25, 0, 0)), 2.5))
        #expect(close(secondsDone(m, 2, Vec3(100, 0, 0)), 10))
        #expect(close(secondsDone(m, 4, Vec3(100, 30, 0)), 13.5))
        #expect(secondsDone(m, 3, Vec3(100, 0, 0)) == 10) // dwelling: no position to go by
        #expect(secondsDone(m, 5) == 15)
    }

    @Test func timesTheOpeningRapidFromAKnownPosition() {
        let m = progressModel("G0 X50", options: .init(rapidRate: 6000), from: Vec3(0, 0, 0))
        #expect(close(m.total, 0.5))
    }

    @Test func findsTheLineTheToolIsOn() {
        let zz = ["G21 G90", "G0 X0 Y0 Z0", "G0 X0 Y0", "G1 X100 F600", "G1 Y10", "G1 X0"].joined(separator: "\n")
        let m = progressModel(zz, options: .init(rapidRate: 5000))
        #expect(lineAtPosition(m, 1, 5, Vec3(40, 0, 0)) == 3)
        #expect(lineAtPosition(m, 1, 5, Vec3(100, 4, 0)) == 4)
        #expect(lineAtPosition(m, 4, 5, Vec3(60, 10, 0)) == 5)
        #expect(lineAtPosition(m, 1, 2, Vec3(40, 0, 0)) == 1) // never past what GRBL has taken
        #expect(lineAtPosition(m, 3, 5, Vec3(55, 3, 0)) == 3) // off every path: the lower bound
    }
}
