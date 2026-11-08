/**
 * Why a lecture has nothing to play.
 *
 * Not every schedule entry is a video class: PW also publishes standalone
 * notes/DPP entries (`isVideoLecture: false`, `lectureType: "PDF"`), upcoming
 * live classes with no recording yet, and recordings the encoder has not
 * finished. All three used to surface as one useless "stream not published"
 * error. This module turns the schedule detail into an answer a student can
 * act on, and it lives in `lib/` so the player route and the diagnostic route
 * always say exactly the same thing.
 */

const DOCUMENT_TYPES = /^(PDF|PNG|JPG|JPEG|NOTE|NOTES|DOC|DOCS|DPP)$/i;
const LIVE_STATUS = /^(NOT_?STARTED|UPCOMING|SCHEDULED|LIVE|IN_?PROGRESS|ONGOING)$/i;

/**
 * @param {object|null} detail schedule detail as returned by `readSchedule`
 * @returns {string} one sentence, shown verbatim in the player
 */
export function explainNoVideo(detail) {
  if (!detail) return "This lecture could not be found in the PW catalogue.";

  const type = String(detail.lectureType || "").trim();
  const status = String(detail.status || "").trim();

  if (detail.isVideoLecture === false || DOCUMENT_TYPES.test(type)) {
    return "This entry is a document, not a video class — open its notes or DPP from the Notes tab.";
  }
  if (LIVE_STATUS.test(status) || /NOT[ _-]?STARTED/i.test(status)) {
    return "This is an upcoming or in-progress live class. PW publishes the recording after the class ends.";
  }
  if (detail.hasNotes) {
    return "PW has not published a recording for this class yet. Its notes and DPPs are available below.";
  }
  return "PW has not published a video for this lecture yet.";
}
