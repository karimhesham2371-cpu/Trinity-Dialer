// NANP US area code → { state, tz } map, for lead timezone derivation and the
// hard 10AM–9PM lead-local calling window (BUILD_SCOPE.md compliance rule).
// tz is an IANA zone. Coverage is the geographic US area codes; toll-free and
// unknowns fall back to the WESTERNMOST US zone (America/Los_Angeles) so we can
// never dial a lead before 10AM their local time — if it's past 10AM Pacific it
// is past 10AM everywhere in the contiguous US.

const AC = {
  // Alabama
  205:['AL','America/Chicago'],251:['AL','America/Chicago'],256:['AL','America/Chicago'],334:['AL','America/Chicago'],659:['AL','America/Chicago'],938:['AL','America/Chicago'],
  // Alaska
  907:['AK','America/Anchorage'],
  // Arizona (no DST; use Phoenix)
  480:['AZ','America/Phoenix'],520:['AZ','America/Phoenix'],602:['AZ','America/Phoenix'],623:['AZ','America/Phoenix'],928:['AZ','America/Phoenix'],
  // Arkansas
  479:['AR','America/Chicago'],501:['AR','America/Chicago'],870:['AR','America/Chicago'],
  // California
  209:['CA','America/Los_Angeles'],213:['CA','America/Los_Angeles'],279:['CA','America/Los_Angeles'],310:['CA','America/Los_Angeles'],323:['CA','America/Los_Angeles'],341:['CA','America/Los_Angeles'],350:['CA','America/Los_Angeles'],408:['CA','America/Los_Angeles'],415:['CA','America/Los_Angeles'],424:['CA','America/Los_Angeles'],442:['CA','America/Los_Angeles'],510:['CA','America/Los_Angeles'],530:['CA','America/Los_Angeles'],559:['CA','America/Los_Angeles'],562:['CA','America/Los_Angeles'],619:['CA','America/Los_Angeles'],626:['CA','America/Los_Angeles'],628:['CA','America/Los_Angeles'],650:['CA','America/Los_Angeles'],657:['CA','America/Los_Angeles'],661:['CA','America/Los_Angeles'],669:['CA','America/Los_Angeles'],707:['CA','America/Los_Angeles'],714:['CA','America/Los_Angeles'],747:['CA','America/Los_Angeles'],760:['CA','America/Los_Angeles'],805:['CA','America/Los_Angeles'],818:['CA','America/Los_Angeles'],820:['CA','America/Los_Angeles'],831:['CA','America/Los_Angeles'],840:['CA','America/Los_Angeles'],858:['CA','America/Los_Angeles'],909:['CA','America/Los_Angeles'],916:['CA','America/Los_Angeles'],925:['CA','America/Los_Angeles'],949:['CA','America/Los_Angeles'],951:['CA','America/Los_Angeles'],
  // Colorado
  303:['CO','America/Denver'],719:['CO','America/Denver'],720:['CO','America/Denver'],970:['CO','America/Denver'],983:['CO','America/Denver'],
  // Connecticut
  203:['CT','America/New_York'],475:['CT','America/New_York'],860:['CT','America/New_York'],959:['CT','America/New_York'],
  // Delaware
  302:['DE','America/New_York'],
  // DC
  202:['DC','America/New_York'],
  // Florida
  239:['FL','America/New_York'],305:['FL','America/New_York'],321:['FL','America/New_York'],352:['FL','America/New_York'],386:['FL','America/New_York'],407:['FL','America/New_York'],448:['FL','America/New_York'],561:['FL','America/New_York'],656:['FL','America/New_York'],689:['FL','America/New_York'],727:['FL','America/New_York'],754:['FL','America/New_York'],772:['FL','America/New_York'],786:['FL','America/New_York'],813:['FL','America/New_York'],850:['FL','America/Chicago'],863:['FL','America/New_York'],904:['FL','America/New_York'],941:['FL','America/New_York'],954:['FL','America/New_York'],
  // Georgia
  229:['GA','America/New_York'],404:['GA','America/New_York'],470:['GA','America/New_York'],478:['GA','America/New_York'],678:['GA','America/New_York'],706:['GA','America/New_York'],762:['GA','America/New_York'],770:['GA','America/New_York'],912:['GA','America/New_York'],943:['GA','America/New_York'],
  // Hawaii
  808:['HI','Pacific/Honolulu'],
  // Idaho (mostly Mountain; north panhandle Pacific — use Mountain)
  208:['ID','America/Boise'],986:['ID','America/Boise'],
  // Illinois
  217:['IL','America/Chicago'],224:['IL','America/Chicago'],309:['IL','America/Chicago'],312:['IL','America/Chicago'],331:['IL','America/Chicago'],447:['IL','America/Chicago'],464:['IL','America/Chicago'],618:['IL','America/Chicago'],630:['IL','America/Chicago'],708:['IL','America/Chicago'],773:['IL','America/Chicago'],779:['IL','America/Chicago'],815:['IL','America/Chicago'],847:['IL','America/Chicago'],872:['IL','America/Chicago'],
  // Indiana (mostly Eastern)
  219:['IN','America/Chicago'],260:['IN','America/Indiana/Indianapolis'],317:['IN','America/Indiana/Indianapolis'],463:['IN','America/Indiana/Indianapolis'],574:['IN','America/Indiana/Indianapolis'],765:['IN','America/Indiana/Indianapolis'],812:['IN','America/Indiana/Indianapolis'],930:['IN','America/Indiana/Indianapolis'],
  // Iowa
  319:['IA','America/Chicago'],515:['IA','America/Chicago'],563:['IA','America/Chicago'],641:['IA','America/Chicago'],712:['IA','America/Chicago'],
  // Kansas
  316:['KS','America/Chicago'],620:['KS','America/Chicago'],785:['KS','America/Chicago'],913:['KS','America/Chicago'],
  // Kentucky (mixed Eastern/Central)
  270:['KY','America/Chicago'],364:['KY','America/Chicago'],502:['KY','America/New_York'],606:['KY','America/New_York'],859:['KY','America/New_York'],
  // Louisiana
  225:['LA','America/Chicago'],318:['LA','America/Chicago'],337:['LA','America/Chicago'],504:['LA','America/Chicago'],985:['LA','America/Chicago'],
  // Maine
  207:['ME','America/New_York'],
  // Maryland
  240:['MD','America/New_York'],301:['MD','America/New_York'],410:['MD','America/New_York'],443:['MD','America/New_York'],667:['MD','America/New_York'],
  // Massachusetts
  339:['MA','America/New_York'],351:['MA','America/New_York'],413:['MA','America/New_York'],508:['MA','America/New_York'],617:['MA','America/New_York'],774:['MA','America/New_York'],781:['MA','America/New_York'],857:['MA','America/New_York'],978:['MA','America/New_York'],
  // Michigan (mostly Eastern; western UP Central — use Eastern)
  231:['MI','America/Detroit'],248:['MI','America/Detroit'],269:['MI','America/Detroit'],313:['MI','America/Detroit'],517:['MI','America/Detroit'],586:['MI','America/Detroit'],616:['MI','America/Detroit'],679:['MI','America/Detroit'],734:['MI','America/Detroit'],810:['MI','America/Detroit'],906:['MI','America/Detroit'],947:['MI','America/Detroit'],989:['MI','America/Detroit'],
  // Minnesota
  218:['MN','America/Chicago'],320:['MN','America/Chicago'],507:['MN','America/Chicago'],612:['MN','America/Chicago'],651:['MN','America/Chicago'],763:['MN','America/Chicago'],952:['MN','America/Chicago'],
  // Mississippi
  228:['MS','America/Chicago'],601:['MS','America/Chicago'],662:['MS','America/Chicago'],769:['MS','America/Chicago'],
  // Missouri
  314:['MO','America/Chicago'],417:['MO','America/Chicago'],557:['MO','America/Chicago'],573:['MO','America/Chicago'],636:['MO','America/Chicago'],660:['MO','America/Chicago'],816:['MO','America/Chicago'],975:['MO','America/Chicago'],
  // Montana
  406:['MT','America/Denver'],
  // Nebraska
  308:['NE','America/Chicago'],402:['NE','America/Chicago'],531:['NE','America/Chicago'],
  // Nevada
  702:['NV','America/Los_Angeles'],725:['NV','America/Los_Angeles'],775:['NV','America/Los_Angeles'],
  // New Hampshire
  603:['NH','America/New_York'],
  // New Jersey
  201:['NJ','America/New_York'],551:['NJ','America/New_York'],609:['NJ','America/New_York'],640:['NJ','America/New_York'],732:['NJ','America/New_York'],848:['NJ','America/New_York'],856:['NJ','America/New_York'],862:['NJ','America/New_York'],908:['NJ','America/New_York'],973:['NJ','America/New_York'],
  // New Mexico
  505:['NM','America/Denver'],575:['NM','America/Denver'],
  // New York
  212:['NY','America/New_York'],315:['NY','America/New_York'],332:['NY','America/New_York'],347:['NY','America/New_York'],363:['NY','America/New_York'],516:['NY','America/New_York'],518:['NY','America/New_York'],585:['NY','America/New_York'],607:['NY','America/New_York'],631:['NY','America/New_York'],646:['NY','America/New_York'],680:['NY','America/New_York'],716:['NY','America/New_York'],718:['NY','America/New_York'],838:['NY','America/New_York'],845:['NY','America/New_York'],914:['NY','America/New_York'],917:['NY','America/New_York'],929:['NY','America/New_York'],934:['NY','America/New_York'],
  // North Carolina
  252:['NC','America/New_York'],336:['NC','America/New_York'],704:['NC','America/New_York'],743:['NC','America/New_York'],828:['NC','America/New_York'],910:['NC','America/New_York'],919:['NC','America/New_York'],980:['NC','America/New_York'],984:['NC','America/New_York'],
  // North Dakota
  701:['ND','America/Chicago'],
  // Ohio
  216:['OH','America/New_York'],220:['OH','America/New_York'],234:['OH','America/New_York'],326:['OH','America/New_York'],330:['OH','America/New_York'],380:['OH','America/New_York'],419:['OH','America/New_York'],440:['OH','America/New_York'],513:['OH','America/New_York'],567:['OH','America/New_York'],614:['OH','America/New_York'],740:['OH','America/New_York'],937:['OH','America/New_York'],
  // Oklahoma
  405:['OK','America/Chicago'],539:['OK','America/Chicago'],572:['OK','America/Chicago'],580:['OK','America/Chicago'],918:['OK','America/Chicago'],
  // Oregon
  458:['OR','America/Los_Angeles'],503:['OR','America/Los_Angeles'],541:['OR','America/Los_Angeles'],971:['OR','America/Los_Angeles'],
  // Pennsylvania
  215:['PA','America/New_York'],223:['PA','America/New_York'],267:['PA','America/New_York'],272:['PA','America/New_York'],412:['PA','America/New_York'],445:['PA','America/New_York'],484:['PA','America/New_York'],570:['PA','America/New_York'],582:['PA','America/New_York'],610:['PA','America/New_York'],717:['PA','America/New_York'],724:['PA','America/New_York'],814:['PA','America/New_York'],835:['PA','America/New_York'],878:['PA','America/New_York'],
  // Rhode Island
  401:['RI','America/New_York'],
  // South Carolina
  803:['SC','America/New_York'],839:['SC','America/New_York'],843:['SC','America/New_York'],854:['SC','America/New_York'],864:['SC','America/New_York'],
  // South Dakota
  605:['SD','America/Chicago'],
  // Tennessee (mixed Eastern/Central)
  423:['TN','America/New_York'],615:['TN','America/Chicago'],629:['TN','America/Chicago'],731:['TN','America/Chicago'],865:['TN','America/New_York'],901:['TN','America/Chicago'],931:['TN','America/Chicago'],
  // Texas
  210:['TX','America/Chicago'],214:['TX','America/Chicago'],254:['TX','America/Chicago'],281:['TX','America/Chicago'],325:['TX','America/Chicago'],346:['TX','America/Chicago'],361:['TX','America/Chicago'],409:['TX','America/Chicago'],430:['TX','America/Chicago'],432:['TX','America/Chicago'],469:['TX','America/Chicago'],512:['TX','America/Chicago'],682:['TX','America/Chicago'],713:['TX','America/Chicago'],726:['TX','America/Chicago'],737:['TX','America/Chicago'],806:['TX','America/Chicago'],817:['TX','America/Chicago'],830:['TX','America/Chicago'],832:['TX','America/Chicago'],903:['TX','America/Chicago'],915:['TX','America/Denver'],936:['TX','America/Chicago'],940:['TX','America/Chicago'],945:['TX','America/Chicago'],956:['TX','America/Chicago'],972:['TX','America/Chicago'],979:['TX','America/Chicago'],
  // Utah
  385:['UT','America/Denver'],435:['UT','America/Denver'],801:['UT','America/Denver'],
  // Vermont
  802:['VT','America/New_York'],
  // Virginia
  276:['VA','America/New_York'],434:['VA','America/New_York'],540:['VA','America/New_York'],571:['VA','America/New_York'],703:['VA','America/New_York'],757:['VA','America/New_York'],804:['VA','America/New_York'],826:['VA','America/New_York'],948:['VA','America/New_York'],
  // Washington
  206:['WA','America/Los_Angeles'],253:['WA','America/Los_Angeles'],360:['WA','America/Los_Angeles'],425:['WA','America/Los_Angeles'],509:['WA','America/Los_Angeles'],564:['WA','America/Los_Angeles'],
  // West Virginia
  304:['WV','America/New_York'],681:['WV','America/New_York'],
  // Wisconsin
  262:['WI','America/Chicago'],274:['WI','America/Chicago'],414:['WI','America/Chicago'],534:['WI','America/Chicago'],608:['WI','America/Chicago'],715:['WI','America/Chicago'],920:['WI','America/Chicago'],
  // Wyoming
  307:['WY','America/Denver'],
};

// Westernmost contiguous-US fallback: guarantees we never dial before 10AM local
// for an unknown area code. (Hawaii/Alaska leads with unknown codes are rare.)
const FALLBACK_TZ = 'America/Los_Angeles';

function lookupAreaCode(ac) {
  const k = parseInt(ac, 10);
  return AC[k] || null;
}
// Returns { state, tz } for an area code; state null + fallback tz when unknown.
function deriveFromAreaCode(ac) {
  const hit = lookupAreaCode(ac);
  return hit ? { state: hit[0], tz: hit[1] } : { state: null, tz: FALLBACK_TZ };
}
// Current local hour (0-23) in an IANA zone, using Intl (no external deps).
function localHour(tz) {
  try {
    const s = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date());
    const h = parseInt(s, 10);
    return h === 24 ? 0 : h;
  } catch { return null; }
}
// Is the lead inside [startHour, endHour) in their local tz right now?
function inCallingWindow(tz, startHour, endHour) {
  const h = localHour(tz || FALLBACK_TZ);
  if (h == null) return true; // fail-open only if Intl itself breaks
  return h >= startHour && h < endHour;
}

module.exports = { deriveFromAreaCode, lookupAreaCode, localHour, inCallingWindow, FALLBACK_TZ };
